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
  private inFlightSourceEvents = new Set<string>();

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
    const openPositions = db.getPaperPositions().filter((p) => p.status !== 'CLOSED');
    
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
    const openPositions = db.getPaperPositions().filter((p) => p.status !== 'CLOSED');
    if (openPositions.length === 0) {
      this.recomputeAccountMetrics();
      return;
    }

    try {
      const prices = await rpcService.getJupiterPricesBatch(openPositions.map((p) => p.tokenMint));

      for (const position of openPositions) {
        if (position.status !== 'OPEN') position.status = 'EXIT_PENDING';

        const freshPrice = prices.get(position.tokenMint);

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
            this.executePaperSellExit(position, freshPrice, exitReason);
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

    const sourceEventId = trade.signature || trade.id;
    const sourceKey = `${trade.walletAddress.toLowerCase()}:${sourceEventId}`;
    // Check both memory and persisted trades so a restart cannot duplicate a fill.
    if (this.inFlightSourceEvents.has(sourceKey) || this.processedSourceSignatures.has(sourceKey) ||
      db.hasPaperTradeForSourceEvent(sourceKey, 'BUY') || db.hasPaperTradeForSourceEvent(sourceEventId, 'BUY')) {
      return false;
    }
    this.inFlightSourceEvents.add(sourceKey);

    // Check for existing OPEN position: prevent multiple OPEN positions for same wallet & token
    const existingActivePosition = db.getActivePaperPosition(trade.walletAddress, trade.tokenMint);
    if (existingActivePosition) {
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
    } catch {
      quotedPriceSol = null;
    }

    // If Jupiter is unavailable or invalid, block the paper BUY. Never use a
    // source execution price, metadata fallback, or fabricated cached value.
    if (!quotedPriceSol || quotedPriceSol <= 0) {
      this.inFlightSourceEvents.delete(sourceKey);
      console.warn(`[PaperTrading] Blocked paper BUY for ${trade.tokenSymbol} (${trade.tokenMint}): invalid or missing Jupiter quote`);
      return false;
    }

    // Mark signature as processed
    this.processedSourceSignatures.add(sourceKey);
    this.inFlightSourceEvents.delete(sourceKey);

    const slippageBps = this.effectiveSlippageBps(settings.simulatedSlippageBps || 50, trade.timestamp || Date.now());
    const fillPrice = quotedPriceSol * (1 + slippageBps / 10000);
    const tokensBought = fillPrice > 0 ? solSpent / fillPrice : 0;
    const simulatedFeeSol = 0.000005; // standard simulated transaction fee

    const tpPercent = settings.takeProfitPercent ?? 30;
    const slPercent = settings.stopLossPercent ?? 15;

    const takeProfitPriceSol = fillPrice * (1 + tpPercent / 100);
    const stopLossPriceSol = fillPrice * (1 - slPercent / 100);

    const paperTradeId = `PAPER-BUY-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const persistedSourceEventId = sourceKey;

    const newPosition: PaperPosition = {
      id: `paper_pos_${trade.walletAddress.slice(0, 6)}_${trade.tokenMint.slice(0, 6)}_${Date.now()}`,
      mode: 'PAPER',
      paperTradeId,
      sourceWalletAddress: trade.walletAddress,
      sourceEventId: persistedSourceEventId,
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
      sourceEventId: persistedSourceEventId,
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
      priceImpactPercent: 0.01,
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
    // Observation-only: source SELLs never mutate a user paper position.
    console.info(`[PaperTrading] Observed source SELL ${trade.signature}; no paper position mutation.`);
  }

  /**
   * Executes a Paper SELL transition when Take Profit or Stop Loss is triggered.
   * Idempotent state transition: EXIT_PENDING -> PAPER_SELLING -> CLOSED.
   */
  public executePaperSellExit(
    position: PaperPosition,
    exitPriceSol: number,
    exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL'
  ): void {
    assertPaperExecution();

    if (position.status === 'CLOSED') return;

    position.status = 'PAPER_SELLING';
    db.savePaperPosition(position);

    try {
      const settings = db.getCopyTradeSettings();
      const slippageBps = settings.simulatedSlippageBps || 50;
      const fillPrice = exitPriceSol * (1 - slippageBps / 10000);
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
      simulatedSlippageBps: slippageBps,
      priceImpactPercent: 0.01,
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
    } catch (err) {
      position.status = 'EXIT_PENDING';
      db.savePaperPosition(position);
      console.error('[PaperTrading] Paper exit failed; left EXIT_PENDING for retry:', err);
    }
  }
}

export const paperTradingService = new PaperTradingService();
