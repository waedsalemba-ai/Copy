import { eventBus, SystemEvents } from './eventBus';
import { db } from './db';
import { rpcService } from './rpcService';
import { buyEntryEngine } from './buyEntryEngine';
import { CanonicalTradeEvent, PaperPosition } from '../types';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PRICE_REFRESH_INTERVAL_MS = 20000;

export class PaperTradingService {
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor() {
    eventBus.on(SystemEvents.TRADE_DETECTED, (trade: CanonicalTradeEvent) => {
      try {
        this.handleTrade(trade);
      } catch (err) {
        console.error('[PaperTrading] Failed to process trade:', err);
      }
    });

    eventBus.on(SystemEvents.BUY_ENTRY_RESOLVED, (payload: { trade: CanonicalTradeEvent; verdict: any }) => {
      if (payload.verdict.verdict === 'BUY') {
        this.executeMirroredBuy(payload.trade);
      }
    });

    this.refreshTimer = setInterval(() => {
      this.refreshOpenPositionPrices().catch((err) => {
        console.error('[PaperTrading] Failed to refresh position prices:', err);
      });
    }, PRICE_REFRESH_INTERVAL_MS);
  }

  private recomputeUnrealized(position: PaperPosition): void {
    position.unrealizedPnlSol = position.quantity * position.currentPriceSol - position.costBasisSol;
  }

  // Mark-to-market: refresh currentPriceSol for every OPEN paper position on
  // an interval, not just when a new trade for that exact wallet+token
  // happens to arrive. Without this, equity looked frozen between trades
  // even while the real token price was moving.
  //
  // Prices are fetched for all open positions in one parallel, deduped batch
  // (rpcService.getPricesBatch) rather than awaited one-by-one in a loop —
  // with N open positions that was N sequential network round trips serialized
  // behind each other, which is the main source of avoidable RPC/API latency
  // here. Positions are only saved/emitted when the price actually moved, to
  // avoid redundant writes every tick.
  private async refreshOpenPositionPrices(): Promise<void> {
    const openPositions = db.getPaperPositions().filter((p) => p.status === 'OPEN');
    if (openPositions.length === 0) return;

    try {
      const prices = await rpcService.getPricesBatch(openPositions.map((p) => p.tokenMint));

      for (const position of openPositions) {
        const meta = prices.get(position.tokenMint);
        if (meta && meta.priceSol > 0 && meta.priceSol !== position.currentPriceSol) {
          position.currentPriceSol = meta.priceSol;
          this.recomputeUnrealized(position);
          db.savePaperPosition(position);
          eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);
        }
      }
    } catch (err) {
      console.error('[PaperTrading] Price refresh batch failed:', err);
    }
  }

  // A real copy-trade is never filled at the exact moment the source wallet's
  // trade landed on-chain — there's always some detection + submission delay,
  // during which the price can keep moving. A flat slippage bps setting
  // ignores that entirely, so paper fills were consistently *more* favorable
  // than a real mirrored trade could actually get. This adds slippage that
  // scales with how long ago the source trade happened, capped so a very
  // stale/backfilled event can't blow up the fill price.
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
    if (trade.tokenMint === SOL_MINT || trade.tokenMint === 'UNKNOWN') return;

    // Only mirror wallets that are actively being monitored.
    const wallet = db.getWalletByAddress(trade.walletAddress);
    if (!wallet || !wallet.enabled) return;

    if (trade.action === 'BUY') {
      this.handleBuy(trade);
    } else {
      this.handleSell(trade);
    }
  }

  private getOrCreatePosition(trade: CanonicalTradeEvent): PaperPosition {
    const existing = db.getPaperPosition(trade.walletAddress, trade.tokenMint);
    if (existing) return existing;

    return {
      id: `paper_${trade.walletAddress.slice(0, 6)}_${trade.tokenMint.slice(0, 6)}_${Date.now()}`,
      sourceWalletAddress: trade.walletAddress,
      traderName: trade.traderName,
      tokenMint: trade.tokenMint,
      tokenSymbol: trade.tokenSymbol,
      tokenDecimals: trade.tokenDecimals,
      quantity: 0,
      costBasisSol: 0,
      avgEntryPriceSol: 0,
      currentPriceSol: trade.executionPriceSol,
      realizedPnlSol: 0,
      unrealizedPnlSol: 0,
      roiPercent: 0,
      traderQuantityShadow: 0,
      entryTimestamp: trade.timestamp,
      lastTradeTimestamp: trade.timestamp,
      status: 'OPEN',
    };
  }

  private handleBuy(trade: CanonicalTradeEvent): void {
    const position = this.getOrCreatePosition(trade);

    // Shadow-track the real trader's quantity regardless of whether copy
    // trading is currently enabled, so sell ratios stay correct even across
    // periods where new buys were paused.
    position.traderQuantityShadow += trade.tokenAmount;
    position.status = 'OPEN';
    position.currentPriceSol = trade.executionPriceSol;
    position.lastTradeTimestamp = trade.timestamp;
    this.recomputeUnrealized(position);
    db.savePaperPosition(position);
    eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);

    const buyEntrySettings = db.getBuyEntrySettings();
    if (!buyEntrySettings.enabled) {
      // No entry gating configured — mirror every copied buy, as before.
      this.executeMirroredBuy(trade);
      return;
    }

    buyEntryEngine.requestEvaluation(trade).catch((err) => {
      console.error('[PaperTrading] Buy-entry evaluation failed, skipping mirror for safety:', err);
    });
  }

  // Extracted so both the immediate copy-buy path and the buy-entry-engine's
  // deferred "resolved to BUY" path can execute an identical simulated fill.
  // Always re-fetches the position fresh rather than trusting a reference
  // captured earlier, since resolution can happen minutes later after other
  // events have touched the same position.
  private executeMirroredBuy(trade: CanonicalTradeEvent): void {
    const position = this.getOrCreatePosition(trade);
    const settings = db.getCopyTradeSettings();
    const account = db.getPaperAccount();

    if (!settings.enabled || account.virtualSolBalance < settings.fixedSolAmountPerTrade) return;

    const slippageBps = this.effectiveSlippageBps(settings.simulatedSlippageBps, trade.timestamp);
    const fillPrice = trade.executionPriceSol * (1 + slippageBps / 10000);
    const solSpent = settings.fixedSolAmountPerTrade;
    const tokensBought = fillPrice > 0 ? solSpent / fillPrice : 0;

    const newQuantity = position.quantity + tokensBought;
    const newCostBasis = position.costBasisSol + solSpent;
    position.quantity = newQuantity;
    position.costBasisSol = newCostBasis;
    position.avgEntryPriceSol = newQuantity > 0 ? newCostBasis / newQuantity : 0;

    db.updatePaperAccount({ virtualSolBalance: account.virtualSolBalance - solSpent });
    db.addPaperTrade({
      id: `ptrade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sourceWalletAddress: trade.walletAddress,
      traderName: trade.traderName,
      sourceSignature: trade.signature,
      tokenMint: trade.tokenMint,
      tokenSymbol: trade.tokenSymbol,
      action: 'BUY',
      tokenAmount: tokensBought,
      solAmount: solSpent,
      executionPriceSol: fillPrice,
      mirrorRatio: 1,
      timestamp: trade.timestamp,
    });

    this.recomputeUnrealized(position);
    db.savePaperPosition(position);
    eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);
    eventBus.emit(SystemEvents.PAPER_TRADE_EXECUTED, db.getPaperTrades(1)[0]);
  }

  private handleSell(trade: CanonicalTradeEvent): void {
    const position = db.getPaperPosition(trade.walletAddress, trade.tokenMint);

    if (!position || position.traderQuantityShadow <= 0) {
      // We never mirrored a buy for this token from this wallet (e.g. copy
      // trading was off when they bought it) — nothing of ours to sell.
      return;
    }

    const sellQtyShadow = Math.min(trade.tokenAmount, position.traderQuantityShadow);
    const sellRatio = sellQtyShadow / position.traderQuantityShadow;
    position.traderQuantityShadow = Math.max(0, position.traderQuantityShadow - trade.tokenAmount);
    position.lastTradeTimestamp = trade.timestamp;
    position.currentPriceSol = trade.executionPriceSol;

    const settings = db.getCopyTradeSettings();
    let tradeExecuted = false;

    // Sells are NOT gated by settings.enabled — closing existing exposure
    // must always be able to mirror the trader, even if new-buy copying is
    // currently paused. Only whether we actually HOLD a paper position
    // (quantity > 0) determines whether there's anything to sell.
    if (position.quantity > 0) {
      const slippageBps = this.effectiveSlippageBps(settings.simulatedSlippageBps, trade.timestamp);
      const fillPrice = trade.executionPriceSol * (1 - slippageBps / 10000);
      const paperSellQty = position.quantity * sellRatio;
      const costBasisOfSale = position.costBasisSol * sellRatio;
      const proceeds = paperSellQty * fillPrice;
      const realizedPnl = proceeds - costBasisOfSale;
      const totalCostBasisBeforeSale = position.costBasisSol;

      position.quantity = Math.max(0, position.quantity - paperSellQty);
      position.costBasisSol = Math.max(0, position.costBasisSol - costBasisOfSale);
      position.realizedPnlSol += realizedPnl;
      position.roiPercent =
        totalCostBasisBeforeSale > 0 ? (position.realizedPnlSol / totalCostBasisBeforeSale) * 100 : 0;

      const account = db.getPaperAccount();
      db.updatePaperAccount({
        virtualSolBalance: account.virtualSolBalance + proceeds,
        totalRealizedPnlSol: account.totalRealizedPnlSol + realizedPnl,
      });

      db.addPaperTrade({
        id: `ptrade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sourceWalletAddress: trade.walletAddress,
        traderName: trade.traderName,
        sourceSignature: trade.signature,
        tokenMint: trade.tokenMint,
        tokenSymbol: trade.tokenSymbol,
        action: 'SELL',
        tokenAmount: paperSellQty,
        solAmount: proceeds,
        executionPriceSol: fillPrice,
        mirrorRatio: sellRatio,
        timestamp: trade.timestamp,
      });
      tradeExecuted = true;

      if (position.quantity <= 0.000001) {
        position.status = 'CLOSED';
        position.exitTimestamp = trade.timestamp;
        position.quantity = 0;
        position.costBasisSol = 0;
      }
    }

    this.recomputeUnrealized(position);
    db.savePaperPosition(position);
    eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);
    if (tradeExecuted) {
      eventBus.emit(SystemEvents.PAPER_TRADE_EXECUTED, db.getPaperTrades(1)[0]);
    }
  }
}

export const paperTradingService = new PaperTradingService();
