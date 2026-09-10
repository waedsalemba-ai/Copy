import { Position, CanonicalTradeEvent } from '../types';
import { db } from './db';
import { rpcService } from './rpcService';
import { eventBus, SystemEvents } from './eventBus';

const LIVE_PRICE_REFRESH_MS = 5000;

export class PositionEngine {
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.refreshTimer = setInterval(() => {
      this.refreshOpenPositionPrices().catch((err) => {
        console.error('[PositionEngine] Live price refresh failed:', err);
      });
    }, LIVE_PRICE_REFRESH_MS);
  }

  public stopInterval(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  public async refreshOpenPositionPrices(): Promise<void> {
    const openPositions = db.getPositions().filter((p) => p.status === 'OPEN');
    if (openPositions.length === 0) return;

    const affectedWallets = new Set<string>();

    try {
      const prices = await rpcService.getPricesBatch(openPositions.map((p) => p.tokenMint));

      for (const position of openPositions) {
        const meta = prices.get(position.tokenMint);
        const freshPrice = meta?.priceSol;
        if (!freshPrice || freshPrice <= 0) continue;

        position.currentPriceSol = freshPrice;
        position.unrealizedPnlSol = position.currentQuantity * freshPrice - position.remainingCostBasisSol;

        db.savePosition(position);
        affectedWallets.add(position.walletAddress);
        eventBus.emit(SystemEvents.POSITION_UPDATED, position);
      }

      affectedWallets.forEach((walletAddress) => this.updateTraderMetrics(walletAddress));
    } catch (err) {
      console.error('[PositionEngine] Price batch fetch failed:', err);
    }
  }

  public processTrade(trade: CanonicalTradeEvent): Position | null {
    // Only BUY and SELL affect position tracking
    if (trade.action !== 'BUY' && trade.action !== 'SELL') {
      return null;
    }

    const walletAddress = trade.walletAddress;
    const tokenMint = trade.tokenMint;

    // Check if there is an existing OPEN position for this wallet and token
    let existing = db.getPosition(walletAddress, tokenMint);

    if (trade.action === 'BUY') {
      if (!existing) {
        // OPEN new position
        const newPosition: Position = {
          id: `pos_${walletAddress.slice(0, 6)}_${tokenMint.slice(0, 6)}_${Date.now()}`,
          walletAddress,
          traderName: trade.traderName,
          tokenMint,
          tokenSymbol: trade.tokenSymbol,
          tokenDecimals: trade.tokenDecimals,
          currentQuantity: trade.tokenAmount,
          initialQuantity: trade.tokenAmount,
          averageEntryPriceSol: trade.executionPriceSol,
          totalCostSol: trade.solAmount,
          remainingCostBasisSol: trade.solAmount,
          exitValueSol: 0,
          realizedPnlSol: 0,
          unrealizedPnlSol: 0,
          roiPercent: 0,
          entryTimestamp: trade.timestamp,
          lastTradeTimestamp: trade.timestamp,
          holdingDurationSeconds: 0,
          buyCount: 1,
          sellCount: 0,
          status: 'OPEN',
          currentPriceSol: trade.executionPriceSol,
        };

        db.savePosition(newPosition);
        trade.positionId = newPosition.id;
        this.updateTraderMetrics(walletAddress, trade.action);
        return newPosition;
      } else {
        // INCREASE existing position
        const newTotalQty = existing.currentQuantity + trade.tokenAmount;
        const newTotalCostSol = existing.totalCostSol + trade.solAmount;
        const newRemainingCostBasis = existing.remainingCostBasisSol + trade.solAmount;
        const newAvgEntryPrice = newTotalCostSol / (existing.initialQuantity + trade.tokenAmount);

        existing.currentQuantity = newTotalQty;
        existing.initialQuantity += trade.tokenAmount;
        existing.totalCostSol = newTotalCostSol;
        existing.remainingCostBasisSol = newRemainingCostBasis;
        existing.averageEntryPriceSol = newAvgEntryPrice;
        existing.lastTradeTimestamp = trade.timestamp;
        existing.holdingDurationSeconds = Math.floor(
          (trade.timestamp - existing.entryTimestamp) / 1000
        );
        existing.buyCount += 1;
        existing.currentPriceSol = trade.executionPriceSol;

        db.savePosition(existing);
        trade.positionId = existing.id;
        this.updateTraderMetrics(walletAddress, trade.action);
        return existing;
      }
    } else if (trade.action === 'SELL' && existing) {
      // REDUCE OR CLOSE existing position
      const sellQty = Math.min(trade.tokenAmount, existing.currentQuantity);
      const sellRatio = existing.currentQuantity > 0 ? sellQty / existing.currentQuantity : 1;

      // Proceeds attributable to the tracked portion of this position only.
      // If trade.tokenAmount exceeds what we have on record (e.g. tokens
      // transferred in from elsewhere, then sold), don't credit this
      // position with proceeds for tokens it never tracked owning.
      const proceedsForTrackedPortion =
        trade.tokenAmount > 0 ? trade.solAmount * (sellQty / trade.tokenAmount) : trade.solAmount;

      // Cost basis of sold portion
      const costBasisOfSale = existing.remainingCostBasisSol * sellRatio;
      const realizedPnlOfThisSale = proceedsForTrackedPortion - costBasisOfSale;

      existing.currentQuantity = Math.max(0, existing.currentQuantity - sellQty);
      existing.remainingCostBasisSol = Math.max(0, existing.remainingCostBasisSol - costBasisOfSale);
      existing.exitValueSol += proceedsForTrackedPortion;
      existing.realizedPnlSol += realizedPnlOfThisSale;
      existing.sellCount += 1;
      existing.lastTradeTimestamp = trade.timestamp;
      existing.holdingDurationSeconds = Math.floor(
        (trade.timestamp - existing.entryTimestamp) / 1000
      );
      existing.currentPriceSol = trade.executionPriceSol;

      // Recompute ROI on every sell, including the one that fully closes the
      // position. Previously this was gated on `remainingCostBasisSol > 0`,
      // which is exactly false on the closing trade (that's what makes it
      // closing), so ROI froze one trade early and never reflected the
      // final realized P&L for a fully-closed position.
      existing.roiPercent =
        existing.totalCostSol > 0 ? (existing.realizedPnlSol / existing.totalCostSol) * 100 : 0;

      // Check if position is fully exited/closed
      if (existing.currentQuantity <= 0.0001) {
        existing.status = 'CLOSED';
        existing.exitTimestamp = trade.timestamp;
        existing.currentQuantity = 0;
        existing.remainingCostBasisSol = 0;
      }

      db.savePosition(existing);
      trade.positionId = existing.id;
      this.updateTraderMetrics(walletAddress, trade.action);
      return existing;
    }

    return null;
  }

  public updateTraderMetrics(walletAddress: string, tradeAction?: 'BUY' | 'SELL'): void {
    const wallet = db.getWalletByAddress(walletAddress);
    if (!wallet) return;

    const positions = db.getPositions(walletAddress);
    const openPositions = positions.filter((p) => p.status === 'OPEN');
    const closedPositions = positions.filter((p) => p.status === 'CLOSED');

    let totalRealizedPnl = 0;
    let totalUnrealizedPnl = 0;
    let wins = 0;
    let largestWin = 0;
    let largestLoss = 0;
    let totalHoldingTime = 0;

    positions.forEach((p) => {
      totalRealizedPnl += p.realizedPnlSol;
      if (p.status === 'OPEN') {
        // Calculate unrealized P&L
        const currentValue = p.currentQuantity * p.currentPriceSol;
        p.unrealizedPnlSol = currentValue - p.remainingCostBasisSol;
        totalUnrealizedPnl += p.unrealizedPnlSol;
      }
      totalHoldingTime += p.holdingDurationSeconds;
    });

    // Win/loss stats are scoped to CLOSED positions only. Previously this
    // counted realizedPnlSol on OPEN positions too (a profitable partial
    // sell on a still-open position isn't a "win" yet), while the rate was
    // divided by totalClosed — a numerator/denominator mismatch that
    // inflated win rate.
    closedPositions.forEach((p) => {
      if (p.realizedPnlSol > 0) {
        wins++;
        if (p.realizedPnlSol > largestWin) largestWin = p.realizedPnlSol;
      } else if (p.realizedPnlSol < 0) {
        if (p.realizedPnlSol < largestLoss) largestLoss = p.realizedPnlSol;
      }
    });

    const totalClosed = closedPositions.length;
    // No fabricated defaults: a wallet with no closed trades yet has a 0%
    // win rate and 0s of holding time, not a made-up 75% / 1 hour.
    const winRatePercent = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;
    const avgHoldingTimeSeconds = positions.length > 0 ? totalHoldingTime / positions.length : 0;

    db.updateWallet(walletAddress, {
      metrics: {
        // Count buys/sells off the actual trade action that triggered this
        // update, not "did this wallet have any position at all" (which
        // incremented totalBuys on every trade, buy or sell, and never
        // incremented totalSells at all).
        totalBuys: wallet.metrics.totalBuys + (tradeAction === 'BUY' ? 1 : 0),
        totalSells: wallet.metrics.totalSells + (tradeAction === 'SELL' ? 1 : 0),
        realizedPnlSol: Number(totalRealizedPnl.toFixed(3)),
        unrealizedPnlSol: Number(totalUnrealizedPnl.toFixed(3)),
        activePositionsCount: openPositions.length,
        winRatePercent: Number(winRatePercent.toFixed(1)),
        avgHoldingTimeSeconds: Math.round(avgHoldingTimeSeconds),
        largestWinSol: Number(largestWin.toFixed(2)),
        largestLossSol: Number(largestLoss.toFixed(2)),
      },
    });

    const updatedWallet = db.getWalletByAddress(walletAddress);
    if (updatedWallet) {
      eventBus.emit(SystemEvents.WALLET_UPDATED, updatedWallet);
    }
  }
}

export const positionEngine = new PositionEngine();
