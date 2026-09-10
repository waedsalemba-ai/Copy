import { eventBus, SystemEvents } from './eventBus';
import { db } from './db';
import { rpcService } from './rpcService';
import { buyEntryEngine } from './buyEntryEngine';
import { CanonicalTradeEvent, CopyTradeSettings, PaperPosition, PaperTrade, BuyEntryVerdict } from '../types';
import { assertPaperExecution } from './paperExecutionGuard';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PRICE_REFRESH_INTERVAL_MS = 15000;

const PROCESSED_SIGNATURES_MAX = 10000;
const PROCESSED_SIGNATURES_TRIM = 2000;

export class PaperTradingService {
  private refreshTimer: NodeJS.Timeout | null = null;
  private processedSourceSignatures = new Set<string>();
  // Wallet+token keys with a buy currently in flight (past the dedup/balance
  // checks but not yet resolved). Closes a TOCTOU race: without this, two
  // BUY events for the same wallet+token arriving close together could both
  // pass the "no existing open position" / "enough balance" checks against
  // stale state (those checks happen before the `await` on the price quote)
  // and both go on to open a position and debit the virtual balance.
  private pendingBuyKeys = new Set<string>();
  private pendingSellKeys = new Set<string>();

  constructor() {
    eventBus.on(SystemEvents.TRADE_DETECTED, (trade: CanonicalTradeEvent) => {
      try {
        this.handleTrade(trade);
      } catch (err) {
        console.error('[PaperTrading] Failed to process trade:', err);
      }
    });

    eventBus.on(SystemEvents.BUY_ENTRY_RESOLVED, (payload: { trade: CanonicalTradeEvent; verdict: BuyEntryVerdict }) => {
      if (payload.verdict?.verdict === 'BUY') {
        this.executeMirroredBuy(payload.trade, payload.verdict);
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

  private lastMetricsComputeTime = 0;
  private metricsComputeThrottleMs = 3000; // Recalculate at most every 3s during continuous refreshes

  private recomputeAccountMetrics(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastMetricsComputeTime < this.metricsComputeThrottleMs) {
      return;
    }
    this.lastMetricsComputeTime = now;

    const account = db.getPaperAccount();
    if (!account) {
      console.error('[PaperTrading] Account not initialized in database');
      return;
    }

    const openPositions = db.getPaperPositions().filter((p) => p.status === 'OPEN');
    
    const investedValueSol = openPositions.reduce((sum, p) => sum + p.costBasisSol, 0);
    const totalUnrealizedPnlSol = openPositions.reduce((sum, p) => sum + p.unrealizedPnlSol, 0);
    
    // Safely handle null values with defaults
    const virtualBalance = account.virtualSolBalance ?? 0;
    const totalPaperEquitySol = virtualBalance + investedValueSol + totalUnrealizedPnlSol;

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

          // Evaluate Take-Profit / Stop-Loss / Trailing-Stop thresholds
          const exitReason = this.evaluateExit(position, freshPrice);

          if (exitReason) {
            this.handleTPSLExitSafely(position, freshPrice, exitReason); // Fire and forget, but safe
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

  /**
   * Updates trailing-stop bookkeeping for a position (high-water mark,
   * activation) and decides whether an exit condition has been hit.
   * Mutates the position's trailing fields as a side effect so the peak
   * price keeps climbing even on refreshes that don't trigger an exit.
   *
   * Once a trailing-enabled position activates (price has risen
   * `trailingActivationPercent` above entry), the fixed take-profit is
   * superseded — the position is instead exited only when price pulls back
   * `trailingStopPercent` from its peak, letting winners run past the
   * original TP target. The static stop-loss still applies underneath as a
   * floor. Positions that never activate keep the original fixed TP/SL
   * behavior untouched.
   */
  private evaluateExit(
    position: PaperPosition,
    freshPrice: number
  ): 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | null {
    if (position.trailingStopEnabled) {
      if (freshPrice > position.highWaterMarkPriceSol) {
        position.highWaterMarkPriceSol = freshPrice;
      }

      if (!position.trailingActive) {
        const activationPriceSol = position.avgEntryPriceSol * (1 + position.trailingActivationPercent / 100);
        if (freshPrice >= activationPriceSol) {
          position.trailingActive = true;
        }
      }

      if (position.trailingActive) {
        position.trailingStopPriceSol = position.highWaterMarkPriceSol * (1 - position.trailingStopPercent / 100);
        const effectiveStop = Math.max(position.trailingStopPriceSol, position.stopLossPriceSol);
        return freshPrice <= effectiveStop ? 'TRAILING_STOP' : null;
      }
    }

    // Trailing not enabled, or enabled but not yet activated.
    if (position.stopLossPriceSol > 0 && freshPrice <= position.stopLossPriceSol) {
      return 'STOP_LOSS';
    }
    if (position.takeProfitPriceSol > 0 && freshPrice >= position.takeProfitPriceSol) {
      return 'TAKE_PROFIT';
    }
    return null;
  }

  /**
   * Safely execute TPSL exit with proper state management and rollback on failure
   */
  private async handleTPSLExitSafely(
    position: PaperPosition,
    freshPrice: number | undefined,
    exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP'
  ): Promise<void> {
    // Guard against concurrent exits for the same position
    if (this.pendingSellKeys.has(position.id)) {
      return;
    }
    this.pendingSellKeys.add(position.id);

    const originalStatus = position.status;
    
    // Don't exit if already closing/closed
    if (originalStatus !== 'OPEN') {
      this.pendingSellKeys.delete(position.id);
      return;
    }

    const price = freshPrice || position.currentPriceSol;

    try {
      // Mark position as pending to prevent concurrent exits
      position.status = 'EXIT_PENDING';
      db.savePaperPosition(position);

      // Execute the actual exit
      await this.executePaperSellExit(position, price, exitReason);
      
      // If exit didn't complete to CLOSED, something went wrong
      if ((position.status as string) !== 'CLOSED') {
        throw new Error('Position did not reach CLOSED state after exit');
      }
    } catch (err) {
      console.error(`[PaperTrading] TPSL exit failed for position ${position.id}:`, err);
      
      // Restore original state on failure (safe because we hold the pendingSellKeys lock)
      position.status = originalStatus;
      db.savePaperPosition(position);
      
      // Emit alert to user UI
      const displayReason =
        exitReason === 'STOP_LOSS' ? 'Stop Loss' : exitReason === 'TRAILING_STOP' ? 'Trailing Stop' : 'Take Profit';
      
      eventBus.emit(SystemEvents.SYSTEM_ALERT, {
        id: `alert_${Date.now()}`,
        type: 'LARGE_TRADE',
        title: `Paper Position ${displayReason} Failed`,
        message: `Position ${position.tokenSymbol} exit encountered an error and was reverted to ${originalStatus} state`,
        traderName: position.traderName,
        timestamp: Date.now(),
        read: false,
      });
    } finally {
      this.pendingSellKeys.delete(position.id);
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

    // Estimate price impact based on exit size and liquidity conditions
    // Larger exits have more impact due to liquidity constraints
    const liquidityImpactFactor = Math.min(
      5, // Cap at 5% max estimated impact
      Math.max(0.01, (params.quantity * params.spotPriceSol) / 10000) // Scales with position size
    );

    return {
      fillPriceSol: params.spotPriceSol * (1 - params.baseSlippageBps / 10000),
      priceImpactPercent: liquidityImpactFactor,
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
    const copyTradeSettings = db.getCopyTradeSettings();
    if (!copyTradeSettings.enabled) return;

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
  /**
   * Confidence-weighted sizing. Blends three independent 0..1 signals —
   * each defaulting to neutral (0.5) when the underlying data isn't
   * available — into a single confidence score, then maps that onto a size
   * multiplier within the configured [minSizeMultiplier, maxSizeMultiplier]
   * bounds. This only scales the user's configured base size up or down; it
   * never picks a size independent of `fixedSolAmountPerTrade`.
   */
  private computeSizeConfidence(
    trade: CanonicalTradeEvent,
    verdict: BuyEntryVerdict | undefined,
    settings: CopyTradeSettings
  ): { confidence: number; multiplier: number } {
    // 1. Source wallet's track record, shrunk toward neutral for small
    // sample sizes so a wallet with 2 trades doesn't swing sizing as hard
    // as one with 200.
    const wallet = db.getWalletByAddress(trade.walletAddress);
    let walletConfidence = 0.5;
    if (wallet) {
      const sampleSize = wallet.metrics.totalBuys + wallet.metrics.totalSells;
      const shrinkage = Math.min(1, sampleSize / 20);
      const rawWinRate = Math.max(0, Math.min(100, wallet.metrics.winRatePercent)) / 100;
      walletConfidence = 0.5 + (rawWinRate - 0.5) * shrinkage;
    }

    // 2. Token rug/risk score (0 safest - 100 most dangerous), inverted.
    // Neutral if the background risk check hasn't resolved yet.
    const risk = trade.riskAnalysis;
    const riskConfidence =
      risk && !risk.pending && typeof risk.score === 'number'
        ? 1 - Math.max(0, Math.min(100, risk.score)) / 100
        : 0.5;

    // 3. Buy-entry momentum score — only present when the buy-entry gate
    // actually evaluated this trade (BuyEntrySettings.enabled).
    const momentumConfidence =
      verdict && typeof verdict.momentumScore === 'number'
        ? Math.max(0, Math.min(100, verdict.momentumScore)) / 100
        : 0.5;

    const confidence = (walletConfidence + riskConfidence + momentumConfidence) / 3;

    const min = settings.minSizeMultiplier ?? 0.4;
    const max = settings.maxSizeMultiplier ?? 1.75;
    const multiplier = min + confidence * (max - min);

    return { confidence, multiplier };
  }

  public async executeMirroredBuy(trade: CanonicalTradeEvent, verdict?: BuyEntryVerdict): Promise<boolean> {
    assertPaperExecution();

    const settings = db.getCopyTradeSettings();
    const account = db.getPaperAccount();

    if (!settings.enabled) return false;

    // Deduplication check: prevent processing same source signature twice
    if (trade.signature && this.processedSourceSignatures.has(`${trade.walletAddress}_${trade.signature}`)) {
      return false;
    }

    // Guard against two overlapping buys for the same wallet+token racing
    // each other through the checks below (both would otherwise pass a
    // stale "no open position" / "enough balance" read, since those checks
    // happen before the async price-quote fetch further down).
    const lockKey = `${trade.walletAddress}:${trade.tokenMint}`;
    if (this.pendingBuyKeys.has(lockKey)) {
      return false;
    }
    this.pendingBuyKeys.add(lockKey);

    try {
      // Check for existing position in any active state (don't allow concurrent positions)
      const existingActivePosition = db.getPaperPosition(trade.walletAddress, trade.tokenMint);
      if (existingActivePosition) {
        console.warn(
          `[PaperTrading] Cannot open new position for ${trade.tokenSymbol}: ` +
          `existing position already in ${existingActivePosition.status} state`
        );
        return false;
      }

      const MIN_TRADABLE_SOL = 0.000001; // 1,000 lamports
      const baseSolSpent = settings.fixedSolAmountPerTrade || 0.5;
      const sizing = settings.confidenceSizingEnabled
        ? this.computeSizeConfidence(trade, verdict, settings)
        : { confidence: 0.5, multiplier: 1 };
      const solSpent = baseSolSpent * sizing.multiplier;
      if (account.virtualSolBalance < solSpent || solSpent < MIN_TRADABLE_SOL) {
        console.warn(`[PaperTrading] Cannot execute BUY: balance (${account.virtualSolBalance}) insufficient or trade amount (${solSpent}) below MIN_TRADABLE_SOL (${MIN_TRADABLE_SOL})`);
        return false;
      }

      // Mark signature (and lock key) as claimed *before* the first await so
      // a concurrent call for the same signature/wallet/token can't slip
      // through while this one is waiting on the network.
      if (trade.signature) {
        this.processedSourceSignatures.add(`${trade.walletAddress}_${trade.signature}`);
        if (this.processedSourceSignatures.size > PROCESSED_SIGNATURES_MAX) {
          const iterator = this.processedSourceSignatures.values();
          for (let i = 0; i < PROCESSED_SIGNATURES_TRIM; i++) {
            const next = iterator.next();
            if (next.done) break;
            this.processedSourceSignatures.delete(next.value);
          }
        }
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

      return await this.finalizeMirroredBuy(trade, settings, solSpent, quotedPriceSol, sizing);
    } finally {
      this.pendingBuyKeys.delete(lockKey);
    }
  }

  private async finalizeMirroredBuy(
    trade: CanonicalTradeEvent,
    settings: CopyTradeSettings,
    solSpent: number,
    quotedPriceSol: number,
    sizing: { confidence: number; multiplier: number }
  ): Promise<boolean> {
    const account = db.getPaperAccount();
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

      sizeMultiplier: sizing.multiplier,
      confidenceScore: sizing.confidence,

      trailingStopEnabled: settings.trailingStopEnabled,
      trailingActivationPercent: settings.trailingActivationPercent ?? 15,
      trailingStopPercent: settings.trailingStopPercent ?? 12,
      trailingActive: false,
      highWaterMarkPriceSol: fillPrice,

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
    this.recomputeAccountMetrics(true); // FIXED: Force immediate equity recalculation

    eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, newPosition);
    eventBus.emit(SystemEvents.PAPER_TRADE_EXECUTED, paperTrade);

    return true;
  }

  /**
   * MANDATORY CRITICAL TRADING RULE:
   * Monitored trader SELL events are strictly informational.
   * A monitored trader SELL must NEVER automatically close a paper position,
   * nor change TP, Stop Sell, entry, or modify any paper position fields.
   * TRADER SELL != PAPER SELL.
   * Paper positions exit exclusively through TP/SL triggers or Manual Exit.
   */
  private async handleSell(trade: CanonicalTradeEvent): Promise<void> {
    console.log(
      `[PaperTrading] INFORMATIONAL: Monitored trader ${trade.traderName} SOLD ${trade.tokenAmount} $${trade.tokenSymbol}. Paper positions remain untouched.`
    );

    // Broadcast informational alert to activity feed
    eventBus.emit(SystemEvents.SYSTEM_ALERT, {
      id: `alert_trader_sell_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'SELL',
      title: `Trader Sold $${trade.tokenSymbol}`,
      message: `${trade.traderName} sold ${trade.tokenAmount?.toLocaleString() || ''} $${trade.tokenSymbol} (Informational only: Paper position remains OPEN)`,
      traderName: trade.traderName,
      walletAddress: trade.walletAddress,
      signature: trade.signature,
      timestamp: Date.now(),
      read: false,
    });
  }

  /**
   * Manual Market Exit requested by user from the terminal interface.
   * Closes 100% of the paper position at the current market fill price.
   */
  public async manualExitPosition(positionId: string): Promise<boolean> {
    const position = db.getPaperPositions().find((p) => p.id === positionId);
    if (!position || position.status !== 'OPEN') {
      return false;
    }

    // Guard against concurrent exits
    if (this.pendingSellKeys.has(position.id)) {
      return false;
    }
    this.pendingSellKeys.add(position.id);

    try {
      await this.executePaperSellExit(position, position.currentPriceSol, 'MANUAL');
      return true;
    } finally {
      this.pendingSellKeys.delete(position.id);
    }
  }

  public isRunning(): boolean {
    return db.getCopyTradeSettings().enabled;
  }

  public start(): void {
    db.updateCopyTradeSettings({ enabled: true });
    db.updateMetrics({ paperTradingRunning: true });
    eventBus.emit(SystemEvents.SETTINGS_UPDATED, db.getSettings());
    console.log('[PaperTrading] Paper Trading Pipeline STARTED');
  }

  public stop(): void {
    db.updateCopyTradeSettings({ enabled: false });
    db.updateMetrics({ paperTradingRunning: false });
    eventBus.emit(SystemEvents.SETTINGS_UPDATED, db.getSettings());
    console.log('[PaperTrading] Paper Trading Pipeline STOPPED (Positions preserved)');
  }

  /**
   * Executes a Paper SELL transition when Take Profit or Stop Loss is triggered.
   * Idempotent state transition: EXIT_PENDING -> PAPER_SELLING -> CLOSED.
   * Full position exit (100% of held quantity).
   */
  public async executePaperSellExit(
    position: PaperPosition,
    exitPriceSol: number,
    exitReason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | 'MANUAL'
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
    this.recomputeAccountMetrics(true); // FIXED: Force immediate equity recalculation

    eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);
    eventBus.emit(SystemEvents.PAPER_TRADE_EXECUTED, paperTrade);
  }
}

export const paperTradingService = new PaperTradingService();
