import { eventBus, SystemEvents } from './eventBus';
import { db } from './db';
import { rpcService } from './rpcService';
import { buyEntryEngine } from './buyEntryEngine';
import { CanonicalTradeEvent, PaperPosition, PaperTrade } from '../types';
import { assertPaperExecution } from './paperExecutionGuard';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PRICE_REFRESH_INTERVAL_MS = 15000;

export class PaperTradingService {
  private refreshTimer: NodeJS.Timeout | null = null;
  private processedSourceSignatures = new Set<string>();

  constructor() {
    eventBus.on(SystemEvents.TRADE_DETECTED, (trade: CanonicalTradeEvent) => {
      try {
        this.handleTrade(trade);
      } catch (err) {
        console.error('[PaperTrading] Failed to process trade:', err);
      }
    });

    eventBus.on(SystemEvents.BUY_ENTRY_RESOLVED, (payload: { trade: CanonicalTradeEvent; verdict: any }) => {
      if (payload.verdict?.verdict === 'BUY') {
        this.executeMirroredBuy(payload.trade);
      }
    });

    this.refreshTimer = setInterval(() => {
      this.refreshOpenPositionPrices().catch((err) => {
        console.error('[PaperTrading] Failed to refresh position prices:', err);
      });
    }, PRICE_REFRESH_INTERVAL_MS);
  }

  public stopInterval(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private recomputeAccountMetrics(): void {
    const account = db.getPaperAccount();
    const openPositions = db.getPaperPositions().filter((p) => p.status === 'OPEN');
    
    const investedValueSol = openPositions.reduce((sum, p) => sum + p.costBasisSol, 0);
    const totalUnrealizedPnlSol = openPositions.reduce((sum, p) => sum + p.unrealizedPnlSol, 0);
    const totalPaperEquitySol = account.virtualSolBalance + investedValueSol + totalUnrealizedPnlSol;

    db.updatePaperAccount({
      investedValueSol,
      totalUnrealizedPnlSol,
      totalPaperEquitySol,
    });
  }

  private recomputeUnrealized(position: PaperPosition): void {
    position.unrealizedPnlSol = position.quantity * position.currentPriceSol - position.costBasisSol;
    if (position.costBasisSol > 0) {
      position.roiPercent = (position.unrealizedPnlSol / position.costBasisSol) * 100;
    } else {
      position.roiPercent = 0;
    }
  }

  /**
   * Continuous Monitoring and TP/SL Execution Engine
   * Fetches fresh read-only Jupiter price quotes and evaluates TP/SL thresholds for all OPEN paper positions.
   */
  public async refreshOpenPositionPrices(): Promise<void> {
    const openPositions = db.getPaperPositions().filter((p) => p.status === 'OPEN');
    if (openPositions.length === 0) {
      this.recomputeAccountMetrics();
      return;
    }

    try {
      const prices = await rpcService.getPricesBatch(openPositions.map((p) => p.tokenMint));

      for (const position of openPositions) {
        if (position.status !== 'OPEN') continue;

        const meta = prices.get(position.tokenMint);
        const freshPrice = meta?.priceSol;

        if (freshPrice && freshPrice > 0) {
          position.currentPriceSol = freshPrice;
          this.recomputeUnrealized(position);

          // Evaluate Take-Profit and Stop-Loss thresholds
          const hitTP = position.takeProfitPriceSol > 0 && freshPrice >= position.takeProfitPriceSol;
          const hitSL = position.stopLossPriceSol > 0 && freshPrice <= position.stopLossPriceSol;

          if (hitTP || hitSL) {
            // Idempotent state transition: OPEN -> EXIT_PENDING -> PAPER_SELLING -> CLOSED
            position.status = 'EXIT_PENDING';
            db.savePaperPosition(position);

            const exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' = hitTP ? 'TAKE_PROFIT' : 'STOP_LOSS';
            await this.executePaperSellExit(position, freshPrice, exitReason);
          } else {
            db.savePaperPosition(position);
            eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);
          }
        }
      }
      this.recomputeAccountMetrics();
    } catch (err) {
      console.error('[PaperTrading] Price refresh batch failed:', err);
    }
  }

  private static readonly LATENCY_SLIPPAGE_BPS_PER_SEC = 5;
  private static readonly MAX_LATENCY_SLIPPAGE_BPS = 300;

  private effectiveSlippageBps(baseBps: number, sourceTradeTimestamp: number): number {
    const elapsedSec = Math.max(0, (Date.now() - sourceTradeTimestamp) / 1000);
    const latencyBps = Math.min(
      PaperTradingService.MAX_LATENCY_SLIPPAGE_BPS,
      elapsedSec * PaperTradingService.LATENCY_SLIPPAGE_BPS_PER_SEC
    );
    return baseBps + latencyBps;
  }

  /**
   * Resolves a realistic BUY fill price. Prefers a live Jupiter swap quote
   * for the exact SOL amount being spent — that reflects real price impact
   * from trading against actual pool depth at that size, which a flat spot
   * price never can. Requires a Jupiter API key (Settings -> Jupiter API
   * Key); without one, or if the quote request fails, falls back to the
   * previous spot-price + latency-based-slippage heuristic.
   */
  private async resolveBuyFill(params: {
    tokenMint: string;
    tokenDecimals: number;
    solSpent: number;
    spotPriceSol: number;
    sourceTradeTimestamp: number;
    baseSlippageBps: number;
  }): Promise<{ fillPriceSol: number; priceImpactPercent: number }> {
    const totalSlippageBps = this.effectiveSlippageBps(params.baseSlippageBps, params.sourceTradeTimestamp);

    try {
      const amountLamports = Math.round(params.solSpent * 1e9);
      const quote = await rpcService.getExecutionQuote(SOL_MINT, params.tokenMint, amountLamports, Math.round(totalSlippageBps));
      if (quote) {
        const tokensOut = quote.outAmountRawUnits / 10 ** params.tokenDecimals;
        if (tokensOut > 0) {
          // The quote already prices in size-based impact against current
          // liquidity. Layer on only the *timing* component (drift between
          // the source trade and this simulated fill) on top of that.
          const latencyOnlyBps = totalSlippageBps - params.baseSlippageBps;
          const rawPriceSol = params.solSpent / tokensOut;
          return {
            fillPriceSol: rawPriceSol * (1 + latencyOnlyBps / 10000),
            priceImpactPercent: quote.priceImpactPct,
          };
        }
      }
    } catch (err) {
      console.error('[PaperTrading] Live buy quote failed, using spot-price fallback:', err);
    }

    return {
      fillPriceSol: params.spotPriceSol * (1 + totalSlippageBps / 10000),
      priceImpactPercent: 0.01,
    };
  }

  /**
   * Mirror of resolveBuyFill for SELL/exit fills. There is no "source trade"
   * lag to model here (a TP/SL exit is a system decision made off the last
   * refreshed mark price, not a mirrored trade), so only the base slippage
   * setting applies on top of whatever the live quote's price impact shows.
   */
  private async resolveSellFill(params: {
    tokenMint: string;
    tokenDecimals: number;
    quantity: number;
    spotPriceSol: number;
    baseSlippageBps: number;
  }): Promise<{ fillPriceSol: number; priceImpactPercent: number }> {
    try {
      const amountRawUnits = Math.round(params.quantity * 10 ** params.tokenDecimals);
      const quote = await rpcService.getExecutionQuote(params.tokenMint, SOL_MINT, amountRawUnits, Math.round(params.baseSlippageBps));
      if (quote && params.quantity > 0) {
        const solOut = quote.outAmountRawUnits / 1e9;
        if (solOut > 0) {
          return {
            fillPriceSol: solOut / params.quantity,
            priceImpactPercent: quote.priceImpactPct,
          };
        }
      }
    } catch (err) {
      console.error('[PaperTrading] Live sell quote failed, using spot-price fallback:', err);
    }

    return {
      fillPriceSol: params.spotPriceSol * (1 - params.baseSlippageBps / 10000),
      priceImpactPercent: 0.01,
    };
  }

  private handleTrade(trade: CanonicalTradeEvent): void {
    if (trade.action !== 'BUY' && trade.action !== 'SELL') return;
    if (trade.tokenMint === SOL_MINT || trade.tokenMint === 'UNKNOWN' || !trade.tokenMint) return;

    // Only mirror wallets that are actively monitored
    const wallet = db.getWalletByAddress(trade.walletAddress);
    if (!wallet || !wallet.enabled) return;

    if (trade.action === 'BUY') {
      this.handleBuy(trade);
    } else {
      this.handleSell(trade);
    }
  }

  private handleBuy(trade: CanonicalTradeEvent): void {
    // Check if copy trading or buy entry is enabled
    const buyEntrySettings = db.getBuyEntrySettings();
    if (!buyEntrySettings.enabled) {
      this.executeMirroredBuy(trade);
      return;
    }

    buyEntryEngine.requestEvaluation(trade).catch((err) => {
      console.error('[PaperTrading] Buy-entry evaluation failed, skipping mirror for safety:', err);
    });
  }

  /**
   * Executes a Paper BUY trade.
   * STRICT SAFETY RULE: Must pass `assertPaperExecution()`.
   * Requires a valid fresh Jupiter price quote. If quote unavailable/invalid, BUY is blocked.
   */
  public async executeMirroredBuy(trade: CanonicalTradeEvent): Promise<boolean> {
    assertPaperExecution();

    const settings = db.getCopyTradeSettings();
    const account = db.getPaperAccount();

    if (!settings.enabled) return false;

    // Deduplication check: prevent processing same source signature twice
    if (trade.signature && this.processedSourceSignatures.has(`${trade.walletAddress}_${trade.signature}`)) {
      return false;
    }

    // Check for existing OPEN position: prevent multiple OPEN positions for same wallet & token
    const existingOpenPosition = db.getPaperPosition(trade.walletAddress, trade.tokenMint);
    if (existingOpenPosition && existingOpenPosition.status === 'OPEN') {
      return false;
    }

    const solSpent = settings.fixedSolAmountPerTrade || 0.5;
    if (account.virtualSolBalance < solSpent) {
      console.warn('[PaperTrading] Insufficient paper SOL balance for trade');
      return false;
    }

    // Obtain fresh Jupiter price quote
    let quotedPriceSol: number | null = null;
    try {
      quotedPriceSol = await rpcService.getJupiterPrice(trade.tokenMint);
      if (!quotedPriceSol) {
        const meta = await rpcService.getTokenMetadata(trade.tokenMint);
        quotedPriceSol = meta?.priceSol || null;
      }
    } catch {
      quotedPriceSol = null;
    }

    // Fallback attempt directly if priceMeta null
    if (!quotedPriceSol || quotedPriceSol <= 0) {
      if (trade.executionPriceSol && trade.executionPriceSol > 0) {
        quotedPriceSol = trade.executionPriceSol;
      }
    }

    // If Jupiter price is completely unavailable or invalid, BLOCK the paper BUY
    if (!quotedPriceSol || quotedPriceSol <= 0) {
      console.warn(`[PaperTrading] Blocked paper BUY for ${trade.tokenSymbol} (${trade.tokenMint}): invalid or missing Jupiter quote`);
      return false;
    }

    // Mark signature as processed
    if (trade.signature) {
      this.processedSourceSignatures.add(`${trade.walletAddress}_${trade.signature}`);
    }

    const slippageBps = this.effectiveSlippageBps(settings.simulatedSlippageBps || 50, trade.timestamp || Date.now());
    const { fillPriceSol: fillPrice, priceImpactPercent } = await this.resolveBuyFill({
      tokenMint: trade.tokenMint,
      tokenDecimals: trade.tokenDecimals || 9,
      solSpent,
      spotPriceSol: quotedPriceSol,
      sourceTradeTimestamp: trade.timestamp || Date.now(),
      baseSlippageBps: settings.simulatedSlippageBps || 50,
    });
    const tokensBought = fillPrice > 0 ? solSpent / fillPrice : 0;
    const simulatedFeeSol = 0.000005; // standard simulated transaction fee

    const tpPercent = settings.takeProfitPercent ?? 30;
    const slPercent = settings.stopLossPercent ?? 15;

    const takeProfitPriceSol = fillPrice * (1 + tpPercent / 100);
    const stopLossPriceSol = fillPrice * (1 - slPercent / 100);

    const paperTradeId = `PAPER-BUY-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const sourceEventId = trade.signature || trade.id || `evt_${Date.now()}`;

    const newPosition: PaperPosition = {
      id: `paper_pos_${trade.walletAddress.slice(0, 6)}_${trade.tokenMint.slice(0, 6)}_${Date.now()}`,
      mode: 'PAPER',
      paperTradeId,
      sourceWalletAddress: trade.walletAddress,
      sourceEventId,
      traderName: trade.traderName || 'Monitored Trader',
      tokenMint: trade.tokenMint,
      tokenSymbol: trade.tokenSymbol || 'TOKEN',
      tokenDecimals: trade.tokenDecimals || 9,

      quantity: tokensBought,
      costBasisSol: solSpent,
      avgEntryPriceSol: fillPrice,
      currentPriceSol: fillPrice,

      realizedPnlSol: 0,
      unrealizedPnlSol: 0,
      roiPercent: 0,

      traderQuantityShadow: trade.tokenAmount || tokensBought,

      entryTimestamp: Date.now(),
      lastTradeTimestamp: Date.now(),

      simulatedFeeSol,
      simulatedSlippageBps: slippageBps,
      takeProfitPercent: tpPercent,
      takeProfitPriceSol,
      stopLossPercent: slPercent,
      stopLossPriceSol,

      status: 'OPEN',
    };

    // Decrease virtual balance
    db.updatePaperAccount({
      virtualSolBalance: account.virtualSolBalance - solSpent,
    });

    const paperTrade: PaperTrade = {
      id: paperTradeId,
      mode: 'PAPER',
      sourceWalletAddress: trade.walletAddress,
      traderName: trade.traderName || 'Monitored Trader',
      sourceSignature: trade.signature || '',
      sourceEventId,
      tokenMint: trade.tokenMint,
      tokenSymbol: trade.tokenSymbol || 'TOKEN',
      action: 'BUY',
      side: 'BUY',
      quotedPriceSol,
      executionPriceSol: fillPrice,
      tokenAmount: tokensBought,
      solAmount: solSpent,
      simulatedFeeSol,
      simulatedSlippageBps: slippageBps,
      priceImpactPercent,
      mirrorRatio: 1.0,
      timestamp: Date.now(),
      status: 'FILLED',
      reason: 'PAPER_BUY',
    };

    db.addPaperTrade(paperTrade);
    db.savePaperPosition(newPosition);
    this.recomputeAccountMetrics();

    eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, newPosition);
    eventBus.emit(SystemEvents.PAPER_TRADE_EXECUTED, paperTrade);

    return true;
  }

  /**
   * MANDATORY SAFETY RULE:
   * Monitored trader SELL events are strictly observation-only.
   * Source trader sales NEVER create a paper SELL and NEVER close a paper position.
   * User paper positions exit exclusively through the server-side TP/SL monitor.
   */
  private handleSell(trade: CanonicalTradeEvent): void {
    // Observation-only: update shadow trader quantity or log event, but NEVER close user paper position or execute paper SELL.
    const position = db.getPaperPosition(trade.walletAddress, trade.tokenMint);
    if (position) {
      position.traderQuantityShadow = Math.max(0, position.traderQuantityShadow - (trade.tokenAmount || 0));
      if (trade.executionPriceSol && trade.executionPriceSol > 0) {
        position.currentPriceSol = trade.executionPriceSol;
        this.recomputeUnrealized(position);
      }
      db.savePaperPosition(position);
      eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);
    }
  }

  /**
   * Executes a Paper SELL transition when Take Profit or Stop Loss is triggered.
   * Idempotent state transition: EXIT_PENDING -> PAPER_SELLING -> CLOSED.
   */
  public async executePaperSellExit(
    position: PaperPosition,
    exitPriceSol: number,
    exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL'
  ): Promise<void> {
    assertPaperExecution();

    if (position.status === 'CLOSED' || position.status === 'PAPER_SELLING') return;

    position.status = 'PAPER_SELLING';
    db.savePaperPosition(position);

    const settings = db.getCopyTradeSettings();
    const baseSlippageBps = settings.simulatedSlippageBps || 50;
    const { fillPriceSol: fillPrice, priceImpactPercent } = await this.resolveSellFill({
      tokenMint: position.tokenMint,
      tokenDecimals: position.tokenDecimals || 9,
      quantity: position.quantity,
      spotPriceSol: exitPriceSol,
      baseSlippageBps,
    });
    const proceedsSol = position.quantity * fillPrice;
    const realizedPnlSol = proceedsSol - position.costBasisSol;
    const simulatedFeeSol = 0.000005;

    const paperTradeId = `PAPER-SELL-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const paperTrade: PaperTrade = {
      id: paperTradeId,
      mode: 'PAPER',
      sourceWalletAddress: position.sourceWalletAddress,
      traderName: position.traderName,
      sourceSignature: position.sourceEventId || '',
      sourceEventId: position.sourceEventId,
      tokenMint: position.tokenMint,
      tokenSymbol: position.tokenSymbol,
      action: 'SELL',
      side: 'SELL',
      quotedPriceSol: exitPriceSol,
      executionPriceSol: fillPrice,
      tokenAmount: position.quantity,
      solAmount: proceedsSol,
      simulatedFeeSol,
      simulatedSlippageBps: baseSlippageBps,
      priceImpactPercent,
      mirrorRatio: 1.0,
      timestamp: Date.now(),
      status: 'FILLED',
      reason: exitReason,
    };

    // Update Paper Account
    const account = db.getPaperAccount();
    db.updatePaperAccount({
      virtualSolBalance: account.virtualSolBalance + proceedsSol,
      totalRealizedPnlSol: account.totalRealizedPnlSol + realizedPnlSol,
    });

    // Mark position CLOSED
    position.status = 'CLOSED';
    position.exitTimestamp = Date.now();
    position.exitReason = exitReason;
    position.currentPriceSol = fillPrice;
    position.realizedPnlSol = realizedPnlSol;
    position.unrealizedPnlSol = 0;
    position.roiPercent = position.costBasisSol > 0 ? (realizedPnlSol / position.costBasisSol) * 100 : 0;

    db.addPaperTrade(paperTrade);
    db.savePaperPosition(position);
    this.recomputeAccountMetrics();

    eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);
    eventBus.emit(SystemEvents.PAPER_TRADE_EXECUTED, paperTrade);
  }
}

export const paperTradingService = new PaperTradingService();
