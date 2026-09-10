# Critical Bug Fixes - Ready to Apply

These are production-ready fixes for the 5 critical bugs identified in the code review.

---

## Fix #1: Account Metrics Initialization (paperTradingService.ts)

**File**: `src/server/paperTradingService.ts`  
**Lines**: 54-66  
**Severity**: HIGH

### Before:
```typescript
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
```

### After:
```typescript
private recomputeAccountMetrics(): void {
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
```

---

## Fix #2: TP/SL Exit Error Handling (paperTradingService.ts)

**File**: `src/server/paperTradingService.ts`  
**Location**: New method to replace current background exit behavior  
**Severity**: HIGH

### Add this new method:
```typescript
/**
 * Safely execute TPSL exit with proper state management and rollback on failure
 */
private async handleTPSLExitSafely(position: PaperPosition): Promise<void> {
  const originalStatus = position.status;
  
  // Don't exit if already closing/closed
  if (originalStatus !== 'OPEN') {
    return;
  }

  try {
    // Mark position as pending to prevent concurrent exits
    position.status = 'EXIT_PENDING';
    db.savePaperPosition(position);

    // Execute the actual exit
    const result = await this.executePaperSellExit(position);
    
    // If exit didn't complete to CLOSED, something went wrong
    if (!result || position.status !== 'CLOSED') {
      throw new Error('Position did not reach CLOSED state after exit');
    }
  } catch (err) {
    console.error(`[PaperTrading] TPSL exit failed for position ${position.id}:`, err);
    
    // Restore original state on failure
    position.status = originalStatus;
    db.savePaperPosition(position);
    
    // Emit alert to user UI
    const exitReason = position.stopLossPriceSol >= position.currentPriceSol 
      ? 'Stop Loss'
      : 'Take Profit';
    
    eventBus.emit(SystemEvents.SYSTEM_ALERT, {
      id: `alert_${Date.now()}`,
      type: 'LARGE_TRADE',
      title: `Paper Position ${exitReason} Failed`,
      message: `Position ${position.tokenSymbol} exit encountered an error and was reverted to OPEN state`,
      traderName: position.traderName,
      timestamp: Date.now(),
      read: false,
    });
  }
}
```

### Then replace the exit call in refreshOpenPositionPrices:
```typescript
// OLD (line ~109):
// this.executePaperSellExit(position).catch((err) => {
//   console.error('[PaperTrading]...', err);
// });

// NEW:
this.handleTPSLExitSafely(position); // Fire and forget, but safe
```

---

## Fix #3: Sell Race Condition (paperTradingService.ts)

**File**: `src/server/paperTradingService.ts`  
**Lines**: Add pendingSellKeys, modify handleSell method  
**Severity**: CRITICAL

### Add to class fields (after line 23):
```typescript
private pendingSellKeys = new Set<string>();
```

### Replace handleSell method (~line 450):
```typescript
private async handleSell(trade: CanonicalTradeEvent): Promise<void> {
  // Create lock key to prevent concurrent sells for same position
  const lockKey = `${trade.walletAddress}:${trade.tokenMint}`;
  
  if (this.pendingSellKeys.has(lockKey)) {
    return; // Already processing a sell for this position, skip
  }
  
  this.pendingSellKeys.add(lockKey);

  try {
    const position = db.getPaperPosition(trade.walletAddress, trade.tokenMint);

    if (!position || position.traderQuantityShadow <= 0) {
      return; // No position to sell
    }

    // Only allow sells for positions we actually hold (quantity > 0)
    if (position.quantity <= 0) {
      return;
    }

    const sellQtyShadow = Math.min(trade.tokenAmount || 0, position.traderQuantityShadow);
    const sellRatio = sellQtyShadow / position.traderQuantityShadow;
    
    position.traderQuantityShadow = Math.max(0, position.traderQuantityShadow - (trade.tokenAmount || 0));
    position.lastTradeTimestamp = Date.now();
    position.currentPriceSol = trade.executionPriceSol || position.currentPriceSol;

    const settings = db.getCopyTradeSettings();
    let tradeExecuted = false;

    const { fillPriceSol: fillPrice } = await this.resolveSellFill({
      tokenMint: trade.tokenMint,
      tokenDecimals: trade.tokenDecimals || 9,
      quantity: position.quantity,
      spotPriceSol: position.currentPriceSol,
      baseSlippageBps: settings.simulatedSlippageBps || 50,
    });

    const paperSellQty = position.quantity * sellRatio;
    const costBasisOfSale = position.costBasisSol * sellRatio;
    const proceeds = paperSellQty * fillPrice;
    const realizedPnl = proceeds - costBasisOfSale;

    position.quantity = Math.max(0, position.quantity - paperSellQty);
    position.costBasisSol = Math.max(0, position.costBasisSol - costBasisOfSale);
    position.realizedPnlSol += realizedPnl;

    if (position.costBasisSol > 0) {
      position.roiPercent = (position.realizedPnlSol / position.costBasisSol) * 100;
    } else {
      position.roiPercent = position.realizedPnlSol > 0 ? 100 : 0;
    }

    const account = db.getPaperAccount();
    if (account) {
      db.updatePaperAccount({
        virtualSolBalance: (account.virtualSolBalance ?? 0) + proceeds,
        totalRealizedPnlSol: (account.totalRealizedPnlSol ?? 0) + realizedPnl,
      });
    }

    // Create paper trade record
    const paperTrade: PaperTrade = {
      id: `PAPER-SELL-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      mode: 'PAPER',
      sourceWalletAddress: trade.walletAddress,
      traderName: trade.traderName || 'Monitored Trader',
      sourceSignature: trade.signature || '',
      sourceEventId: trade.id || `evt_${Date.now()}`,
      tokenMint: trade.tokenMint,
      tokenSymbol: trade.tokenSymbol || 'TOKEN',
      action: 'SELL',
      side: 'SELL',
      quotedPriceSol: position.currentPriceSol,
      executionPriceSol: fillPrice,
      tokenAmount: paperSellQty,
      solAmount: proceeds,
      simulatedFeeSol: 0.000005,
      simulatedSlippageBps: settings.simulatedSlippageBps || 50,
      priceImpactPercent: 0.01,
      mirrorRatio: sellRatio,
      timestamp: Date.now(),
      status: 'FILLED',
      reason: 'OBSERVE_SELL',
    };

    db.addPaperTrade(paperTrade);
    tradeExecuted = true;

    // Close position if fully sold (accounting for dust)
    if (position.quantity <= 0.000001) {
      position.quantity = 0;
      position.costBasisSol = 0;
      position.status = 'CLOSED';
      position.exitTimestamp = Date.now();
    }

    this.recomputeUnrealized(position);
    db.savePaperPosition(position);
    this.recomputeAccountMetrics();

    eventBus.emit(SystemEvents.PAPER_POSITION_UPDATED, position);
    if (tradeExecuted) {
      eventBus.emit(SystemEvents.PAPER_TRADE_EXECUTED, paperTrade);
    }
  } finally {
    this.pendingSellKeys.delete(lockKey);
  }
}
```

---

## Fix #4: Position State Machine Validation (paperTradingService.ts)

**File**: `src/server/paperTradingService.ts`  
**Lines**: 285-289  
**Severity**: MEDIUM

### Before:
```typescript
// Check for existing OPEN position: prevent multiple OPEN positions for same wallet & token
const existingOpenPosition = db.getPaperPosition(trade.walletAddress, trade.tokenMint);
if (existingOpenPosition && existingOpenPosition.status === 'OPEN') {
  return false;
}
```

### After:
```typescript
// Check for existing position in any active state (don't allow concurrent positions)
const existingOpenPosition = db.getPaperPosition(trade.walletAddress, trade.tokenMint);
if (existingOpenPosition) {
  // Reject if position is not CLOSED (includes OPEN, EXIT_PENDING, PAPER_SELLING)
  if (existingOpenPosition.status !== 'CLOSED') {
    console.warn(
      `[PaperTrading] Cannot open new position for ${trade.tokenSymbol}: ` +
      `existing position in ${existingOpenPosition.status} state`
    );
    return false;
  }
}
```

---

## Fix #5: Slippage Calculation for Exits (paperTradingService.ts)

**File**: `src/server/paperTradingService.ts`  
**Lines**: 220-223  
**Severity**: MEDIUM

### Before:
```typescript
return {
  fillPriceSol: params.spotPriceSol * (1 - params.baseSlippageBps / 10000),
  priceImpactPercent: 0.01, // Hardcoded!
};
```

### After:
```typescript
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
```

---

## Deployment Checklist

- [ ] Apply all 5 fixes above in order
- [ ] Run `npm run lint` to verify TypeScript compilation
- [ ] Test paper trading flow: BUY → PRICE MOVE → TPSL TRIGGER → SELL
- [ ] Simulate 5 concurrent sells on same position (verify only 1 executes)
- [ ] Verify account metrics are calculated correctly after trades
- [ ] Check WebSocket broadcasts still work after changes
- [ ] Monitor logs for 1 hour post-deployment

---

## Rollback Plan

If issues occur:
1. Revert to previous version
2. Check logs for specific error
3. Create issue ticket referencing this document
4. Apply fixes one at a time with testing between each

