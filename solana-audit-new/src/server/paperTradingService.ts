import { eventBus, SystemEvents } from './eventBus';
import { db } from './db';
import { rpcService } from './rpcService';
import { buyEntryEngine } from './buyEntryEngine';
import { CanonicalTradeEvent, PaperPosition, PaperTrade } from '../types';
import { assertPaperExecution, createPaperTradeId, PAPER_EXECUTION_MODE } from './paperExecutionGuard';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PRICE_REFRESH_INTERVAL_MS = 20000;
const SIMULATED_FEE_RATE = 0.001;

/** Paper-only copy trading. This service deliberately has no signer, swap
 * transaction builder, or transaction broadcaster. Source SELL events are
 * observations only and can never close a user paper position. */
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
        try {
          void this.executePaperBuy(payload.trade);
        } catch (err) {
          console.error('[PaperTrading] Paper BUY rejected:', err);
        }
      }
    });

    this.refreshTimer = setInterval(() => {
      this.refreshOpenPositionPrices().catch((err) => {
        console.error('[PaperTrading] Failed to refresh paper positions:', err);
      });
    }, PRICE_REFRESH_INTERVAL_MS);
  }

  private recomputeUnrealized(position: PaperPosition): void {
    position.unrealizedPnlSol = position.quantity * position.currentPriceSol - position.costBasisSol;
    position.roiPercent = position.costBasisSol > 0
      ? ((position.unrealizedPnlSol + position.realizedPnlSol) / position.costBasisSol) * 100
      : 0;
  }

  private async refreshOpenPositionPrices(): Promise<void> {
    const openPositions = db.getPaperPositions().filter((p) => p.status === 'OPEN');
    if (openPositions.length === 0) return;
    const prices = new Map<string, number>();
    await Promise.all(openPositions.map(async (position) => {
      const price = await rpcService.getJupiterPrice(position.tokenMint);
      if (price && price > 0) prices.set(position.tokenMint, price);
    }));

    for (const position of openPositions) {
      const priceSol = prices.get(position.tokenMint);
      if (!priceSol || !Number.isFinite(priceSol) || priceSol <= 0) continue;
      position.currentPriceSol = priceSol;
      this.recomputeUnrealized(position);
      db.savePaperPosition(position);
      eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);

      const tp = position.takeProfitPrice;
      const sl = position.stopLossPrice;
      if (tp && priceSol >= tp) {
        this.executePaperExit(position, priceSol, 'TAKE_PROFIT');
      } else if (sl && priceSol <= sl) {
        this.executePaperExit(position, priceSol, 'STOP_LOSS');
      }
    }
  }

  private effectiveSlippageBps(baseBps: number, sourceTimestamp: number): number {
    const latencyBps = Math.min(300, Math.max(0, (Date.now() - sourceTimestamp) / 1000) * 5);
    return baseBps + latencyBps;
  }

  private handleTrade(trade: CanonicalTradeEvent): void {
    if (trade.action !== 'BUY' && trade.action !== 'SELL') return;
    if (trade.tokenMint === SOL_MINT || trade.tokenMint === 'UNKNOWN') return;
    const wallet = db.getWalletByAddress(trade.walletAddress);
    if (!wallet || !wallet.enabled) return;

    if (trade.action === 'BUY') {
      const settings = db.getBuyEntrySettings();
      if (!settings.enabled) {
        void this.executePaperBuy(trade);
      } else {
        buyEntryEngine.requestEvaluation(trade).catch((err) => {
          console.error('[PaperTrading] Buy-entry evaluation failed; no paper BUY:', err);
        });
      }
      return;
    }

    // A monitored trader's SELL is never a user exit. Only this service's
    // TP/SL state machine may create a paper SELL.
    console.info(`[PaperTrading] Ignoring source SELL ${trade.signature}; paper positions remain open.`);
  }

  private async executePaperBuy(trade: CanonicalTradeEvent): Promise<void> {
    assertPaperExecution();
    if (PAPER_EXECUTION_MODE !== 'PAPER') throw new Error('Paper BUY blocked outside PAPER mode');
    if (db.hasPaperTradeForSourceEvent(trade.id, 'BUY') || db.hasPaperTradeForSourceEvent(trade.signature, 'BUY')) return;

    const settings = db.getCopyTradeSettings();
    const account = db.getPaperAccount();
    if (!settings.enabled || account.virtualSolBalance < settings.fixedSolAmountPerTrade) return;
    if (db.getPaperPosition(trade.walletAddress, trade.tokenMint)) return;
    const quotedPrice = await rpcService.getJupiterPrice(trade.tokenMint);
    if (!Number.isFinite(quotedPrice) || quotedPrice <= 0) {
      console.warn(`[PaperTrading] No valid Jupiter-derived quote for ${trade.tokenMint}; paper BUY blocked.`);
      return;
    }

    const slippageBps = this.effectiveSlippageBps(settings.simulatedSlippageBps, trade.timestamp);
    const fillPrice = quotedPrice * (1 + slippageBps / 10000);
    const solSpent = settings.fixedSolAmountPerTrade;
    const fee = solSpent * SIMULATED_FEE_RATE;
    const tokensBought = (solSpent - fee) / fillPrice;
    const takeProfitPrice = fillPrice * (1 + settings.takeProfitPercent / 100);
    const stopLossPrice = fillPrice * (1 - settings.stopLossPercent / 100);
    const tradeId = createPaperTradeId('BUY');

    const position: PaperPosition = {
      id: `paper-position-${tradeId}`,
      tradeId,
      sourceEventId: trade.id,
      sourceWalletAddress: trade.walletAddress,
      traderName: trade.traderName,
      tokenMint: trade.tokenMint,
      tokenSymbol: trade.tokenSymbol,
      tokenDecimals: trade.tokenDecimals,
      quantity: tokensBought,
      costBasisSol: solSpent,
      avgEntryPriceSol: fillPrice,
      currentPriceSol: fillPrice,
      realizedPnlSol: 0,
      unrealizedPnlSol: 0,
      roiPercent: 0,
      traderQuantityShadow: 0,
      entryTimestamp: Date.now(),
      lastTradeTimestamp: Date.now(),
      status: 'OPEN',
      mode: 'PAPER',
      takeProfitPercent: settings.takeProfitPercent,
      stopLossPercent: settings.stopLossPercent,
      takeProfitPrice,
      stopLossPrice,
    };

    const paperTrade: PaperTrade = {
      id: tradeId,
      paperTradeId: tradeId,
      sourceEventId: trade.id,
      sourceWalletAddress: trade.walletAddress,
      traderName: trade.traderName,
      sourceSignature: trade.signature,
      tokenMint: trade.tokenMint,
      tokenSymbol: trade.tokenSymbol,
      action: 'BUY',
      tokenAmount: tokensBought,
      solAmount: solSpent,
      executionPriceSol: fillPrice,
      quotedPrice,
      simulatedFeesSol: fee,
      simulatedSlippageBps: slippageBps,
      priceImpactPct: 0,
      mirrorRatio: 1,
      timestamp: Date.now(),
      mode: 'PAPER',
      reason: 'PAPER_BUY',
    };

    db.updatePaperAccount({ virtualSolBalance: account.virtualSolBalance - solSpent });
    db.addPaperTrade(paperTrade);
    db.savePaperPosition(position);
    eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);
    eventBus.emit(SystemEvents.PAPER_TRADE_EXECUTED, paperTrade);
  }

  private executePaperExit(position: PaperPosition, quotedPrice: number, reason: 'TAKE_PROFIT' | 'STOP_LOSS'): void {
    assertPaperExecution();
    if (position.status !== 'OPEN' || position.quantity <= 0) return;
    if (db.hasPaperTradeForSourceEvent(position.id, 'SELL')) return;

    const settings = db.getCopyTradeSettings();
    const slippageBps = Math.max(0, settings.simulatedSlippageBps);
    const fillPrice = quotedPrice * (1 - slippageBps / 10000);
    const proceedsBeforeFee = position.quantity * fillPrice;
    const fee = proceedsBeforeFee * SIMULATED_FEE_RATE;
    const proceeds = proceedsBeforeFee - fee;
    const realizedPnl = proceeds - position.costBasisSol;
    const paperTradeId = createPaperTradeId('SELL');

    position.status = 'CLOSED';
    position.exitTimestamp = Date.now();
    position.lastTradeTimestamp = Date.now();
    position.currentPriceSol = fillPrice;
    position.realizedPnlSol += realizedPnl;
    position.quantity = 0;
    position.costBasisSol = 0;
    position.unrealizedPnlSol = 0;
    position.exitReason = reason;

    const account = db.getPaperAccount();
    const paperTrade: PaperTrade = {
      id: paperTradeId,
      paperTradeId,
      sourceEventId: position.id,
      sourceWalletAddress: position.sourceWalletAddress,
      traderName: position.traderName,
      sourceSignature: `PAPER-EXIT-${position.id}`,
      tokenMint: position.tokenMint,
      tokenSymbol: position.tokenSymbol,
      action: 'SELL',
      tokenAmount: 0,
      solAmount: proceeds,
      executionPriceSol: fillPrice,
      quotedPrice,
      simulatedFeesSol: fee,
      simulatedSlippageBps: slippageBps,
      priceImpactPct: 0,
      mirrorRatio: 1,
      timestamp: Date.now(),
      mode: 'PAPER',
      reason,
    };

    db.updatePaperAccount({
      virtualSolBalance: account.virtualSolBalance + proceeds,
      totalRealizedPnlSol: account.totalRealizedPnlSol + realizedPnl,
    });
    db.addPaperTrade(paperTrade);
    db.savePaperPosition(position);
    eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);
    eventBus.emit(SystemEvents.PAPER_TRADE_EXECUTED, paperTrade);
  }
}

export const paperTradingService = new PaperTradingService();
