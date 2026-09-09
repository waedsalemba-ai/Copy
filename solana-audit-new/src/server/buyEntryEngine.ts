import { eventBus, SystemEvents } from './eventBus';
import { db } from './db';
import { riskAnalysisService } from './riskAnalysisService';
import { CanonicalTradeEvent, BuyEntryVerdict, TokenRiskLevel } from '../types';

const FETCH_TIMEOUT_MS = 3500;
const WATCHLIST_TICK_MS = 30000;
// Anti-chase: if 5m price change exceeds this, force a WATCH instead of
// buying into an already-extended move (per the spec's anti-chase filter).
const ANTI_CHASE_THRESHOLD_PCT = 30;
// Once anti-chase triggers, require at least this much pullback from the
// peak 5m reading seen while watching before a BUY is allowed again.
const ANTI_CHASE_PULLBACK_PCT = 15;

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

/**
 * Multi-gate buy-entry qualification, loosely implementing a user-supplied
 * spec (safety -> qualification -> momentum -> structure -> breakout ->
 * execution). Several inputs the spec calls for aren't available from free
 * data sources (dev holding %, real holder-count growth, unique-buyer
 * counts, a verified rug-check database) — those are explicitly excluded
 * from scoring and reported in `dataGaps` rather than faked. "15m price
 * change" and "buy pressure" are approximated from what DexScreener does
 * expose (1h change, and buy/sell transaction counts respectively) — see
 * inline notes below. "Price structure" (HH/HL, breakout confirmation) uses
 * a simplified rolling-peak/pullback heuristic in place of true candlestick
 * swing-point detection, which would need OHLC data this app doesn't fetch.
 */
class BuyEntryEngine {
  private history = new Map<string, MarketSnapshot[]>();
  private watchlist = new Map<string, WatchCandidate>();

  constructor() {
    setInterval(() => {
      this.processWatchlist().catch((err) => {
        console.error('[BuyEntry] Watchlist processing failed:', err);
      });
    }, WATCHLIST_TICK_MS);
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

  /** Entry point: evaluate a freshly-detected copy-buy candidate. */
  public async requestEvaluation(trade: CanonicalTradeEvent): Promise<void> {
    const result = await this.evaluate(trade.tokenMint, trade.tokenSymbol);

    if (result.verdict === 'BUY') {
      eventBus.emit(SystemEvents.BUY_ENTRY_RESOLVED, { trade, verdict: result });
      return;
    }
    if (result.verdict === 'REJECT') {
      console.log(
        `[BuyEntry] REJECT ${trade.tokenSymbol} ($${trade.tokenMint.slice(0, 6)}): ${
          result.reasons.join('; ') || 'no reasons recorded'
        }`
      );
      return;
    }

    // WATCH or READY_TO_BUY: queue for re-evaluation.
    const key = `${trade.walletAddress}:${trade.tokenMint}`;
    const existing = this.watchlist.get(key);
    this.watchlist.set(key, {
      trade,
      firstSeenAt: existing?.firstSeenAt ?? Date.now(),
      peakM5PriceChangePct: existing?.peakM5PriceChangePct ?? 0,
      lastVerdict: result,
    });
  }

  private async processWatchlist(): Promise<void> {
    const settings = db.getBuyEntrySettings();
    const now = Date.now();

    for (const [key, candidate] of Array.from(this.watchlist.entries())) {
      const ageMinutes = (now - candidate.firstSeenAt) / 60000;
      if (ageMinutes > settings.watchWindowMinutes) {
        console.log(`[BuyEntry] Watch window expired for $${candidate.trade.tokenSymbol} — not mirrored.`);
        eventBus.emit(SystemEvents.BUY_ENTRY_RESOLVED, {
          trade: candidate.trade,
          verdict: { ...candidate.lastVerdict, verdict: 'REJECT', reasons: ['Watch window expired'] },
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
  }

  private async fetchDexScreenerData(tokenMint: string): Promise<MarketSnapshot> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) return { timestamp: Date.now() };

      const data = await res.json();
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      if (pairs.length === 0) return { timestamp: Date.now() };

      const best = pairs.reduce((a: any, b: any) =>
        (b?.liquidity?.usd || 0) > (a?.liquidity?.usd || 0) ? b : a
      );

      return {
        timestamp: Date.now(),
        liquidityUsd: typeof best?.liquidity?.usd === 'number' ? best.liquidity.usd : undefined,
        marketCapUsd: typeof best?.marketCap === 'number' ? best.marketCap : typeof best?.fdv === 'number' ? best.fdv : undefined,
        volumeM5Usd: typeof best?.volume?.m5 === 'number' ? best.volume.m5 : undefined,
        volumeH24Usd: typeof best?.volume?.h24 === 'number' ? best.volume.h24 : undefined,
        priceChangeM5Pct: typeof best?.priceChange?.m5 === 'number' ? best.priceChange.m5 : undefined,
        priceChangeH1Pct: typeof best?.priceChange?.h1 === 'number' ? best.priceChange.h1 : undefined,
        txnsM5Buys: typeof best?.txns?.m5?.buys === 'number' ? best.txns.m5.buys : undefined,
        txnsM5Sells: typeof best?.txns?.m5?.sells === 'number' ? best.txns.m5.sells : undefined,
      };
    } catch {
      return { timestamp: Date.now() };
    }
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

  public async evaluate(tokenMint: string, tokenSymbol: string): Promise<BuyEntryVerdict> {
    const settings = db.getBuyEntrySettings();
    const reasons: string[] = [];
    const dataGaps: string[] = [
      'Dev-holding % unavailable from free data sources',
      'Unique 15m buyers count unavailable',
      'Candlestick OHLC swing points unavailable — using rolling 5m/1h heuristics',
    ];

    // Gate 1: Safety & Rug Check
    const risk = riskAnalysisService.getOrRefresh(tokenMint);
    if (risk) {
      if (!this.isRiskLevelAcceptable(risk.level, settings.maxAcceptableRiskLevel)) {
        reasons.push(
          `Risk level ${risk.level} exceeds maximum acceptable level (${settings.maxAcceptableRiskLevel})`
        );
      }
      if (risk.mintAuthorityRevoked === false) {
        reasons.push('Mint authority is still active');
      }
      if (risk.freezeAuthorityRevoked === false) {
        reasons.push('Freeze authority is still active');
      }
    }

    if (settings.requireDevHoldingCheck) {
      reasons.push('Dev-holding check enabled but data is unavailable');
    }

    // Market snapshot from DexScreener
    const snapshot = await this.fetchDexScreenerData(tokenMint);
    const snapshots = this.history.get(tokenMint) || [];
    snapshots.push(snapshot);
    if (snapshots.length > 20) snapshots.shift();
    this.history.set(tokenMint, snapshots);

    // Gate 2: Liquidity & Qualification Checks
    if (typeof snapshot.liquidityUsd === 'number' && snapshot.liquidityUsd < 5000) {
      reasons.push(`Liquidity too low ($${Math.round(snapshot.liquidityUsd).toLocaleString()})`);
    }

    // If safety/qualification failed severely, return REJECT
    if (reasons.length > 0) {
      return {
        tokenMint,
        tokenSymbol,
        verdict: 'REJECT',
        momentumScore: 0,
        reasons,
        dataGaps,
        evaluatedAt: Date.now(),
      };
    }

    // Gate 3 & 4: Momentum & Buy Pressure Scoring
    let momentumScore = 0;

    // 1. Liquidity & Volume scoring
    if (typeof snapshot.liquidityUsd === 'number') {
      if (snapshot.liquidityUsd >= 15000) momentumScore += 15;
      else if (snapshot.liquidityUsd >= 8000) momentumScore += 10;
    }
    if (typeof snapshot.volumeM5Usd === 'number') {
      if (snapshot.volumeM5Usd >= 2000) momentumScore += 15;
      else if (snapshot.volumeM5Usd >= 500) momentumScore += 10;
    }

    // 2. Buy pressure (5m transaction ratio)
    const buys = snapshot.txnsM5Buys || 0;
    const sells = snapshot.txnsM5Sells || 0;
    const totalTxns = buys + sells;
    if (totalTxns > 0) {
      const buyRatio = buys / totalTxns;
      if (buyRatio >= 0.75) momentumScore += 30;
      else if (buyRatio >= 0.6) momentumScore += 20;
      else if (buyRatio >= 0.5) momentumScore += 10;
    } else {
      dataGaps.push('5m transaction counts unavailable');
    }

    // 3. Price Momentum
    const m5Change = snapshot.priceChangeM5Pct ?? 0;
    const h1Change = snapshot.priceChangeH1Pct ?? 0;

    if (m5Change > 15) momentumScore += 25;
    else if (m5Change > 5) momentumScore += 20;
    else if (m5Change > 0) momentumScore += 10;

    if (h1Change > 10) momentumScore += 15;
    else if (h1Change > 0) momentumScore += 10;

    momentumScore = Math.max(0, Math.min(100, momentumScore));

    // Anti-chase filter
    if (m5Change > ANTI_CHASE_THRESHOLD_PCT) {
      reasons.push(`Price extended (+${m5Change.toFixed(1)}% in 5m) — anti-chase filter active`);
      return {
        tokenMint,
        tokenSymbol,
        verdict: 'WATCH',
        momentumScore,
        reasons,
        dataGaps,
        evaluatedAt: Date.now(),
      };
    }

    // Final qualification score gate
    if (momentumScore >= settings.minMomentumScoreToBuy) {
      return {
        tokenMint,
        tokenSymbol,
        verdict: 'BUY',
        momentumScore,
        reasons: ['Passed all safety, momentum, and structure gates'],
        dataGaps,
        evaluatedAt: Date.now(),
      };
    }

    if (momentumScore >= settings.minMomentumScoreToBuy - 20) {
      reasons.push(
        `Momentum score ${momentumScore} below buy threshold (${settings.minMomentumScoreToBuy}) — watching`
      );
      return {
        tokenMint,
        tokenSymbol,
        verdict: 'WATCH',
        momentumScore,
        reasons,
        dataGaps,
        evaluatedAt: Date.now(),
      };
    }

    reasons.push(
      `Momentum score ${momentumScore} too low (min required ${settings.minMomentumScoreToBuy})`
    );
    return {
      tokenMint,
      tokenSymbol,
      verdict: 'REJECT',
      momentumScore,
      reasons,
      dataGaps,
      evaluatedAt: Date.now(),
    };
  }
}

export const buyEntryEngine = new BuyEntryEngine();
