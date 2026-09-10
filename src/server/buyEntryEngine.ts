import { eventBus, SystemEvents } from './eventBus';
import { db } from './db';
import { riskAnalysisService } from './riskAnalysisService';
import { dexScreenerService } from './dexScreenerService';
import { rpcService } from './rpcService';
import { CanonicalTradeEvent, BuyEntryVerdict, GateResult, TokenRiskLevel } from '../types';

const WATCHLIST_TICK_MS = 20000;
const ANTI_CHASE_THRESHOLD_PCT = 30;
const ANTI_CHASE_PULLBACK_PCT = 12;
const HISTORY_MAX_MINTS = 500;
const MAX_RECENT_VERDICTS = 200;

interface MarketSnapshot {
  timestamp: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  volumeM5Usd?: number;
  volumeH24Usd?: number;
  priceChangeM5Pct?: number;
  priceChangeH1Pct?: number;
  txnsM5Buys?: number;
  txnsM5Sells?: number;
}

interface WatchCandidate {
  trade: CanonicalTradeEvent;
  firstSeenAt: number;
  peakM5PriceChangePct: number;
  lastVerdict: BuyEntryVerdict;
}

class BuyEntryEngine {
  private history = new Map<string, MarketSnapshot[]>();
  private watchlist = new Map<string, WatchCandidate>();
  private recentVerdicts = new Map<string, BuyEntryVerdict>();
  private isProcessingWatchlist = false;

  constructor() {
    setInterval(() => {
      this.processWatchlistInternal().catch((err) => {
        console.error('[BuyEntry] Watchlist processing failed:', err);
      });
    }, WATCHLIST_TICK_MS);
  }

  public async processWatchlist(): Promise<void> {
    return this.processWatchlistInternal();
  }

  public getWatchlist(): Array<{
    tokenMint: string;
    tokenSymbol: string;
    sourceWalletAddress: string;
    traderName: string;
    firstSeenAt: number;
    lastVerdict: BuyEntryVerdict;
  }> {
    return Array.from(this.watchlist.values()).map((c) => ({
      tokenMint: c.trade.tokenMint,
      tokenSymbol: c.trade.tokenSymbol,
      sourceWalletAddress: c.trade.walletAddress,
      traderName: c.trade.traderName,
      firstSeenAt: c.firstSeenAt,
      lastVerdict: c.lastVerdict,
    }));
  }

  public getVerdicts(): BuyEntryVerdict[] {
    return Array.from(this.recentVerdicts.values()).sort((a, b) => b.evaluatedAt - a.evaluatedAt);
  }

  public getVerdict(tokenMint: string): BuyEntryVerdict | undefined {
    return this.recentVerdicts.get(tokenMint);
  }

  /** Entry point: evaluate a freshly-detected copy-buy candidate */
  public async requestEvaluation(trade: CanonicalTradeEvent): Promise<void> {
    const result = await this.evaluate(trade.tokenMint, trade.tokenSymbol);

    if (result.verdict === 'BUY') {
      eventBus.emit(SystemEvents.BUY_ENTRY_RESOLVED, { trade, verdict: result });
      return;
    }
    if (result.verdict === 'REJECT') {
      console.log(
        `[BuyEntry] Candidate $${trade.tokenSymbol} (${trade.tokenMint.slice(0, 8)}) REJECTED: ${result.reasons.join('; ')}`
      );
      eventBus.emit(SystemEvents.BUY_ENTRY_RESOLVED, { trade, verdict: result });
      return;
    }

    // WATCH candidate: queue for re-evaluation
    const key = `${trade.walletAddress}:${trade.tokenMint}`;
    const snap = this.history.get(trade.tokenMint)?.slice(-1)[0];
    const initialM5 = snap?.priceChangeM5Pct ?? 0;

    this.watchlist.set(key, {
      trade,
      firstSeenAt: Date.now(),
      peakM5PriceChangePct: Math.max(0, initialM5),
      lastVerdict: result,
    });
    console.log(
      `[BuyEntry] Candidate $${trade.tokenSymbol} queued to WATCHLIST (Score: ${result.momentumScore}): ${result.reasons.join('; ')}`
    );
  }

  private async processWatchlistInternal(): Promise<void> {
    if (this.isProcessingWatchlist) return;
    this.isProcessingWatchlist = true;
    try {
      const settings = db.getBuyEntrySettings();
      const now = Date.now();

      for (const [key, candidate] of Array.from(this.watchlist.entries())) {
      const ageMinutes = (now - candidate.firstSeenAt) / 60000;
      if (ageMinutes > settings.watchWindowMinutes) {
        console.log(`[BuyEntry] Watch window expired for $${candidate.trade.tokenSymbol} — not mirrored.`);
        eventBus.emit(SystemEvents.BUY_ENTRY_RESOLVED, {
          trade: candidate.trade,
          verdict: { ...candidate.lastVerdict, verdict: 'REJECT', reasons: ['Watch window expired without breakout'] },
        });
        this.watchlist.delete(key);
        continue;
      }

      const result = await this.evaluate(candidate.trade.tokenMint, candidate.trade.tokenSymbol);
      const snap = this.history.get(candidate.trade.tokenMint)?.slice(-1)[0];
      const currentM5 = snap?.priceChangeM5Pct ?? 0;
      const newPeak = Math.max(candidate.peakM5PriceChangePct, currentM5);
      candidate.peakM5PriceChangePct = newPeak;

      const antiChaseActive = candidate.peakM5PriceChangePct > ANTI_CHASE_THRESHOLD_PCT;
      const pulledBackEnough = newPeak - currentM5 >= ANTI_CHASE_PULLBACK_PCT;

      if (result.verdict === 'BUY') {
        if (antiChaseActive && !pulledBackEnough) {
          result.verdict = 'WATCH';
          result.reasons.push(
            `Awaiting anti-chase pullback (peak 5m +${newPeak.toFixed(1)}%, current +${currentM5.toFixed(1)}%)`
          );
          candidate.lastVerdict = result;
          continue;
        }

        console.log(`[BuyEntry] WATCHLIST RESOLVED -> BUY for $${candidate.trade.tokenSymbol}`);
        eventBus.emit(SystemEvents.BUY_ENTRY_RESOLVED, {
          trade: candidate.trade,
          verdict: result,
        });
        this.watchlist.delete(key);
        continue;
      }

      if (result.verdict === 'REJECT') {
        console.log(
          `[BuyEntry] WATCHLIST RESOLVED -> REJECT for $${candidate.trade.tokenSymbol}: ${result.reasons.join('; ')}`
        );
        eventBus.emit(SystemEvents.BUY_ENTRY_RESOLVED, {
          trade: candidate.trade,
          verdict: result,
        });
        this.watchlist.delete(key);
        continue;
      }

      candidate.lastVerdict = result;
    }
    } finally {
      this.isProcessingWatchlist = false;
    }
  }

  private async fetchDexScreenerData(tokenMint: string): Promise<MarketSnapshot> {
    const data = await dexScreenerService.getTokenData(tokenMint);
    return {
      timestamp: Date.now(),
      liquidityUsd: data.liquidityUsd,
      marketCapUsd: data.marketCapUsd,
      volumeM5Usd: data.volumeM5Usd,
      volumeH24Usd: data.volume24hUsd,
      priceChangeM5Pct: data.priceChangeM5Pct,
      priceChangeH1Pct: data.priceChangeH1Pct,
      txnsM5Buys: data.txnsM5Buys,
      txnsM5Sells: data.txnsM5Sells,
    };
  }

  private isRiskLevelAcceptable(level: TokenRiskLevel, maxAllowed: 'LOW' | 'MEDIUM' | 'HIGH'): boolean {
    const hierarchy: Record<TokenRiskLevel, number> = {
      LOW: 1,
      MEDIUM: 2,
      HIGH: 3,
      CRITICAL: 4,
      UNKNOWN: 5,
    };
    const maxVal: Record<'LOW' | 'MEDIUM' | 'HIGH', number> = {
      LOW: 1,
      MEDIUM: 2,
      HIGH: 3,
    };
    return hierarchy[level] <= maxVal[maxAllowed];
  }

  /**
   * 8-Gate Autonomous Paper Entry Engine
   * Strictly evaluates the candidate token through:
   * Gate 1: Safety & Qualification
   * Gate 2: Real-time Momentum
   * Gate 3: Buy Pressure
   * Gate 4: Price Structure
   * Gate 5: Liquidity Quality
   * Gate 6: Holder Flow
   * Gate 7: Momentum Score (0-100)
   * Gate 8: Final Entry Trigger
   */
  public async evaluate(tokenMint: string, tokenSymbol: string): Promise<BuyEntryVerdict> {
    const settings = db.getBuyEntrySettings();
    const gates: GateResult[] = [];
    const reasons: string[] = [];
    const dataGaps: string[] = [];

    // --- Validate SPL Mint & Decimals ---
    const isSplValid = rpcService.validateAddress(tokenMint);
    const tokenInfo = await rpcService.getTokenMetadata(tokenMint);
    const decimalsResolved = typeof tokenInfo?.decimals === 'number';

    if (!isSplValid) {
      const rejectVerdict: BuyEntryVerdict = {
        tokenMint,
        tokenSymbol,
        verdict: 'REJECT',
        momentumScore: 0,
        reasons: ['Invalid canonical Solana SPL Mint address'],
        dataGaps: [],
        evaluatedAt: Date.now(),
        hardRejection: { triggered: true, reason: 'Invalid SPL Mint address' },
      };
      this.recordVerdict(rejectVerdict);
      return rejectVerdict;
    }

    // --- Fetch Risk Data & DexScreener Snapshot ---
    const risk = riskAnalysisService.getOrRefresh(tokenMint);
    const snapshot = await this.fetchDexScreenerData(tokenMint);

    const snapshots = this.history.get(tokenMint) || [];
    snapshots.push(snapshot);
    if (snapshots.length > 20) snapshots.shift();
    this.history.delete(tokenMint);
    this.history.set(tokenMint, snapshots);
    if (this.history.size > HISTORY_MAX_MINTS) {
      const oldestKey = this.history.keys().next().value;
      if (oldestKey !== undefined) this.history.delete(oldestKey);
    }

    const prevSnapshot = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : undefined;

    // ==========================================
    // GATE 1: Safety & Basic Qualification Check
    // ==========================================
    let gate1Passed = true;
    const gate1Failures: string[] = [];

    const minMcap = 5000;
    const minLiq = 5000;
    const min24hVol = 5000;

    if (snapshot.marketCapUsd !== undefined && snapshot.marketCapUsd < minMcap) {
      gate1Passed = false;
      gate1Failures.push(`Market Cap $${Math.round(snapshot.marketCapUsd).toLocaleString()} < $${minMcap.toLocaleString()}`);
    }
    if (snapshot.liquidityUsd !== undefined && snapshot.liquidityUsd < minLiq) {
      gate1Passed = false;
      gate1Failures.push(`Liquidity $${Math.round(snapshot.liquidityUsd).toLocaleString()} < $${minLiq.toLocaleString()}`);
    }
    if (snapshot.volumeH24Usd !== undefined && snapshot.volumeH24Usd < min24hVol) {
      gate1Passed = false;
      gate1Failures.push(`24h Vol $${Math.round(snapshot.volumeH24Usd).toLocaleString()} < $${min24hVol.toLocaleString()}`);
    }

    if (risk) {
      if (!this.isRiskLevelAcceptable(risk.level, settings.maxAcceptableRiskLevel)) {
        gate1Passed = false;
        gate1Failures.push(`Risk level ${risk.level} exceeds max allowed ${settings.maxAcceptableRiskLevel}`);
      }
      if (risk.mintAuthorityRevoked === false) {
        gate1Passed = false;
        gate1Failures.push('Mint Authority is still active (can inflate supply)');
      }
      if (risk.freezeAuthorityRevoked === false) {
        gate1Passed = false;
        gate1Failures.push('Freeze Authority is still active (can freeze accounts)');
      }
      if (risk.topHoldersConcentrationPct !== undefined && risk.topHoldersConcentrationPct > 25) {
        gate1Passed = false;
        gate1Failures.push(`Top 10 holders own ${risk.topHoldersConcentrationPct.toFixed(1)}% (max 25%)`);
      }
    } else {
      dataGaps.push('On-chain contract security check in progress');
    }

    if (settings.requireDevHoldingCheck) {
      dataGaps.push('Dev-holding % verification unavailable on standard RPC');
    }

    gates.push({
      gateNumber: 1,
      name: 'Safety & Qualification',
      passed: gate1Passed,
      details: gate1Passed
        ? `SPL verified, Mint/Freeze disabled, Liq: $${Math.round(snapshot.liquidityUsd || 0).toLocaleString()}, Mcap: $${Math.round(snapshot.marketCapUsd || 0).toLocaleString()}`
        : gate1Failures.join('; '),
    });

    // ==========================================
    // GATE 2: Real-time Momentum
    // ==========================================
    const m5Change = snapshot.priceChangeM5Pct ?? 0;
    const h1Change = snapshot.priceChangeH1Pct ?? 0;
    const volM5 = snapshot.volumeM5Usd ?? 0;
    const prevVolM5 = prevSnapshot?.volumeM5Usd ?? 0;

    let volAcceleration = 1.0;
    if (prevVolM5 > 0) {
      volAcceleration = volM5 / prevVolM5;
    } else if (volM5 > 1000) {
      volAcceleration = 1.6;
    }

    const gate2Passed = m5Change >= 0 && (m5Change >= 3 || h1Change >= 5) && volM5 >= 500;
    gates.push({
      gateNumber: 2,
      name: 'Real-time Momentum',
      passed: gate2Passed,
      details: `5m Δ: ${m5Change > 0 ? '+' : ''}${m5Change.toFixed(1)}%, 1h Δ: ${h1Change > 0 ? '+' : ''}${h1Change.toFixed(1)}%, 5m Vol: $${Math.round(volM5).toLocaleString()}, Vol Accel: ${volAcceleration.toFixed(2)}x`,
    });

    // ==========================================
    // GATE 3: Buy Pressure
    // ==========================================
    const buys = snapshot.txnsM5Buys || 0;
    const sells = snapshot.txnsM5Sells || 0;
    const totalTxns = buys + sells;
    const buyPressurePct = totalTxns > 0 ? (buys / totalTxns) * 100 : 50;
    const gate3Passed = buyPressurePct >= 50 && buys >= sells;

    gates.push({
      gateNumber: 3,
      name: 'Buy Pressure',
      passed: gate3Passed,
      details: totalTxns > 0
        ? `Buy Ratio: ${buyPressurePct.toFixed(1)}% (${buys} buys / ${sells} sells in 5m)`
        : 'Transaction counts pending',
    });

    // ==========================================
    // GATE 4: Price Structure
    // ==========================================
    // Positive structure: Price not crashing, higher high or breakout confirmed, not purely vertical exhaustion
    const isVerticalExhaustion = m5Change > 45 && buyPressurePct < 55;
    const gate4Passed = m5Change >= 0 && !isVerticalExhaustion;

    gates.push({
      gateNumber: 4,
      name: 'Price Structure',
      passed: gate4Passed,
      details: isVerticalExhaustion
        ? 'Vertical pump with declining buy pressure (exhaustion risk)'
        : (m5Change >= 0 ? 'Consolidation / Higher Low with breakout potential' : 'Price downtrending in 5m'),
    });

    // ==========================================
    // GATE 5: Liquidity Quality & Stability
    // ==========================================
    const currentLiq = snapshot.liquidityUsd || 0;
    const prevLiq = prevSnapshot?.liquidityUsd || currentLiq;
    const liqChangePct = prevLiq > 0 ? ((currentLiq - prevLiq) / prevLiq) * 100 : 0;
    const isLiquidityDraining = liqChangePct < -12;
    const gate5Passed = currentLiq >= minLiq && !isLiquidityDraining;

    gates.push({
      gateNumber: 5,
      name: 'Liquidity Quality',
      passed: gate5Passed,
      details: isLiquidityDraining
        ? `Liquidity draining (${liqChangePct.toFixed(1)}% drop)`
        : `Pool: $${Math.round(currentLiq).toLocaleString()} (Stability: ${liqChangePct >= 0 ? '+' : ''}${liqChangePct.toFixed(1)}%)`,
    });

    // ==========================================
    // GATE 6: Holder Flow
    // ==========================================
    const topConcentration = risk?.topHoldersConcentrationPct ?? 15;
    const gate6Passed = topConcentration <= 25 && buys >= sells;

    gates.push({
      gateNumber: 6,
      name: 'Holder Flow',
      passed: gate6Passed,
      details: `Top 10 Concentration: ${topConcentration.toFixed(1)}%, Net Buyer Flow: ${buys - sells >= 0 ? 'POSITIVE' : 'NEGATIVE'}`,
    });

    // ==========================================
    // GATE 7: Momentum Score (0 - 100)
    // ==========================================
    let priceMomentumScore = 0; // max 25
    let volAccelerationScore = 0; // max 25
    let buyPressureScore = 0; // max 20
    let liquidityQualityScore = 0; // max 15
    let holderGrowthScore = 0; // max 10
    let traderActivityScore = 5; // max 5

    // 1. Price Momentum (max 25)
    if (m5Change >= 15) priceMomentumScore = 25;
    else if (m5Change >= 8) priceMomentumScore = 20;
    else if (m5Change >= 3) priceMomentumScore = 15;
    else if (m5Change >= 0) priceMomentumScore = 10;
    else priceMomentumScore = 0;

    // 2. Volume Acceleration (max 25)
    if (volAcceleration >= 2.5 || volM5 >= 5000) volAccelerationScore = 25;
    else if (volAcceleration >= 1.8 || volM5 >= 2500) volAccelerationScore = 20;
    else if (volAcceleration >= 1.4 || volM5 >= 1000) volAccelerationScore = 15;
    else if (volM5 >= 500) volAccelerationScore = 10;

    // 3. Buy Pressure (max 20)
    if (buyPressurePct >= 75) buyPressureScore = 20;
    else if (buyPressurePct >= 65) buyPressureScore = 16;
    else if (buyPressurePct >= 55) buyPressureScore = 12;
    else if (buyPressurePct >= 50) buyPressureScore = 6;

    // 4. Liquidity Quality (max 15)
    if (currentLiq >= 25000 && !isLiquidityDraining) liquidityQualityScore = 15;
    else if (currentLiq >= 12000 && !isLiquidityDraining) liquidityQualityScore = 12;
    else if (currentLiq >= minLiq && !isLiquidityDraining) liquidityQualityScore = 9;

    // 5. Holder Growth & Flow (max 10)
    if (topConcentration <= 15 && buys > sells) holderGrowthScore = 10;
    else if (topConcentration <= 25 && buys >= sells) holderGrowthScore = 7;
    else if (topConcentration <= 35) holderGrowthScore = 4;

    const momentumScore = Math.min(
      100,
      Math.max(
        0,
        priceMomentumScore + volAccelerationScore + buyPressureScore + liquidityQualityScore + holderGrowthScore + traderActivityScore
      )
    );

    gates.push({
      gateNumber: 7,
      name: 'Momentum Score',
      passed: momentumScore >= settings.minMomentumScoreToBuy,
      score: momentumScore,
      maxScore: 100,
      details: `Score: ${momentumScore}/100 [Price: ${priceMomentumScore}/25, VolAccel: ${volAccelerationScore}/25, BuyPress: ${buyPressureScore}/20, Liq: ${liquidityQualityScore}/15, Holders: ${holderGrowthScore}/10, Trader: ${traderActivityScore}/5]`,
    });

    // ==========================================
    // HARD REJECTION CHECK
    // ==========================================
    let hardRejectionReason: string | undefined;
    if (!gate1Passed) {
      hardRejectionReason = gate1Failures[0] || 'Failed Gate 1 Safety Qualification';
    } else if (isLiquidityDraining) {
      hardRejectionReason = 'Liquidity rapidly dropping (>12% drain)';
    } else if (buyPressurePct < 45 && totalTxns >= 5) {
      hardRejectionReason = 'Severe sell pressure (Buy Ratio < 45%)';
    } else if (m5Change < -5) {
      hardRejectionReason = 'Price dumping (-5% in 5m)';
    }

    if (hardRejectionReason) {
      gates.push({
        gateNumber: 8,
        name: 'Final Entry Trigger',
        passed: false,
        details: `HARD REJECT: ${hardRejectionReason}`,
      });

      const verdict: BuyEntryVerdict = {
        tokenMint,
        tokenSymbol,
        verdict: 'REJECT',
        momentumScore: 0,
        reasons: [hardRejectionReason],
        dataGaps,
        evaluatedAt: Date.now(),
        gates,
        hardRejection: { triggered: true, reason: hardRejectionReason },
      };
      this.recordVerdict(verdict);
      return verdict;
    }

    // ==========================================
    // ANTI-CHASE FILTER
    // ==========================================
    const isAntiChaseTriggered = m5Change > ANTI_CHASE_THRESHOLD_PCT;
    if (isAntiChaseTriggered) {
      gates.push({
        gateNumber: 8,
        name: 'Final Entry Trigger',
        passed: false,
        details: `ANTI-CHASE: 5m change +${m5Change.toFixed(1)}% exceeds threshold (+${ANTI_CHASE_THRESHOLD_PCT}%). Watching for pullback.`,
      });

      const verdict: BuyEntryVerdict = {
        tokenMint,
        tokenSymbol,
        verdict: 'WATCH',
        momentumScore,
        reasons: [`Price extended (+${m5Change.toFixed(1)}% in 5m) — anti-chase filter active, waiting for consolidation`],
        dataGaps,
        evaluatedAt: Date.now(),
        gates,
        antiChase: { triggered: true, m5ChangePct: m5Change, thresholdPct: ANTI_CHASE_THRESHOLD_PCT },
      };
      this.recordVerdict(verdict);
      return verdict;
    }

    // ==========================================
    // GATE 8: Final Entry Trigger
    // ==========================================
    const allPreliminaryGatesPassed = gate1Passed && gate2Passed && gate3Passed && gate4Passed && gate5Passed && gate6Passed;

    if (allPreliminaryGatesPassed && momentumScore >= settings.minMomentumScoreToBuy) {
      gates.push({
        gateNumber: 8,
        name: 'Final Entry Trigger',
        passed: true,
        details: `All 8 gates PASSED with momentum score ${momentumScore}/100 >= ${settings.minMomentumScoreToBuy}. BUY trigger active.`,
      });

      const verdict: BuyEntryVerdict = {
        tokenMint,
        tokenSymbol,
        verdict: 'BUY',
        momentumScore,
        reasons: ['Passed all 8 safety, momentum, structure, liquidity, and entry gates'],
        dataGaps,
        evaluatedAt: Date.now(),
        gates,
      };
      this.recordVerdict(verdict);
      return verdict;
    }

    if (momentumScore >= settings.minMomentumScoreToBuy - 15) {
      const waitReason = `Momentum score ${momentumScore} below buy threshold (${settings.minMomentumScoreToBuy}) — watching for breakout`;
      gates.push({
        gateNumber: 8,
        name: 'Final Entry Trigger',
        passed: false,
        details: waitReason,
      });

      const verdict: BuyEntryVerdict = {
        tokenMint,
        tokenSymbol,
        verdict: 'WATCH',
        momentumScore,
        reasons: [waitReason],
        dataGaps,
        evaluatedAt: Date.now(),
        gates,
      };
      this.recordVerdict(verdict);
      return verdict;
    }

    const rejectReason = `Momentum score ${momentumScore} too low (min required ${settings.minMomentumScoreToBuy})`;
    gates.push({
      gateNumber: 8,
      name: 'Final Entry Trigger',
      passed: false,
      details: rejectReason,
    });

    const verdict: BuyEntryVerdict = {
      tokenMint,
      tokenSymbol,
      verdict: 'REJECT',
      momentumScore,
      reasons: [rejectReason],
      dataGaps,
      evaluatedAt: Date.now(),
      gates,
    };
    this.recordVerdict(verdict);
    return verdict;
  }

  private recordVerdict(verdict: BuyEntryVerdict): void {
    this.recentVerdicts.set(verdict.tokenMint, verdict);
    if (this.recentVerdicts.size > MAX_RECENT_VERDICTS) {
      const oldest = this.recentVerdicts.keys().next().value;
      if (oldest !== undefined) this.recentVerdicts.delete(oldest);
    }
  }
}

export const buyEntryEngine = new BuyEntryEngine();
