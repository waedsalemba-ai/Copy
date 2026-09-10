import { PublicKey } from '@solana/web3.js';
import { TokenRiskAnalysis, TokenRiskLevel } from '../types';
import { rpcService } from './rpcService';
import { eventBus, SystemEvents } from './eventBus';
import { dexScreenerService } from './dexScreenerService';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const CACHE_TTL_MS = 5 * 60 * 1000; // re-check every 5 minutes
const FETCH_TIMEOUT_MS = 3500;
// Every mint ever analyzed used to get a permanent cache entry — a slow
// memory leak on a long-running process. Oldest entries (Map insertion
// order) are evicted once this cap is hit.
const CACHE_MAX_ENTRIES = 3000;

/**
 * Best-effort, free-data-only rug/scam risk read for an SPL token mint.
 *
 * This is NOT a substitute for real due diligence — it combines a handful of
 * cheap, publicly available signals (mint/freeze authority state, DexScreener
 * liquidity + pair age, holder concentration) into a single directional
 * score. It cannot detect e.g. malicious transfer-hook programs, hidden
 * team wallets split across many addresses, or off-chain rug vectors.
 */
class RiskAnalysisService {
  private cache = new Map<string, TokenRiskAnalysis>();
  private inFlight = new Set<string>();

  /**
   * Returns the freshest available risk read for `tokenMint`, kicking off a
   * background refresh if the cache is missing or stale. Always returns
   * synchronously (never blocks the classification pipeline) — callers that
   * want the resolved result should listen for SystemEvents.TOKEN_RISK_UPDATED.
   */
  public getOrRefresh(tokenMint: string): TokenRiskAnalysis | undefined {
    if (!tokenMint || tokenMint === 'UNKNOWN' || tokenMint === SOL_MINT) {
      return undefined;
    }

    const cached = this.cache.get(tokenMint);
    const isFresh = cached && !cached.pending && Date.now() - cached.analyzedAt < CACHE_TTL_MS;

    if (!isFresh && !this.inFlight.has(tokenMint)) {
      this.inFlight.add(tokenMint);
      this.analyze(tokenMint)
        .then((result) => {
          this.setCache(tokenMint, result);
          eventBus.emit(SystemEvents.TOKEN_RISK_UPDATED, result);
        })
        .catch((err) => {
          const fallback: TokenRiskAnalysis = {
            tokenMint,
            level: 'UNKNOWN',
            score: 0,
            flags: ['Risk analysis failed — could not verify'],
            pending: false,
            analyzedAt: Date.now(),
            error: err?.message || 'Unknown error',
          };
          this.setCache(tokenMint, fallback);
          eventBus.emit(SystemEvents.TOKEN_RISK_UPDATED, fallback);
        })
        .finally(() => this.inFlight.delete(tokenMint));
    }

    if (cached) return cached;

    // First time we've ever seen this mint: return a pending placeholder so
    // the UI can show "checking..." instead of nothing.
    const pending: TokenRiskAnalysis = {
      tokenMint,
      level: 'UNKNOWN',
      score: 0,
      flags: [],
      pending: true,
      analyzedAt: Date.now(),
    };
    this.setCache(tokenMint, pending);
    return pending;
  }

  private setCache(tokenMint: string, value: TokenRiskAnalysis): void {
    // Re-inserting an existing key moves it to the end of Map iteration
    // order, so eviction below correctly drops the least-recently-updated
    // mint rather than an arbitrary one.
    this.cache.delete(tokenMint);
    this.cache.set(tokenMint, value);
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        resolved = true;
        resolve(fallback);
      }, ms);

      promise
        .then((result) => {
          if (!resolved) {
            clearTimeout(timer);
            resolve(result);
          }
        })
        .catch(() => {
          if (!resolved) {
            clearTimeout(timer);
            resolve(fallback); // Gracefully fallback on error too
          }
        });
    });
  }

  private async fetchDexScreenerStats(
    tokenMint: string
  ): Promise<{
    liquidityUsd?: number;
    ageMinutes?: number;
    volume24hUsd?: number;
    marketCapUsd?: number;
  }> {
    const data = await dexScreenerService.getTokenData(tokenMint);
    return {
      liquidityUsd: data.liquidityUsd,
      ageMinutes: data.ageMinutes,
      volume24hUsd: data.volume24hUsd,
      marketCapUsd: data.marketCapUsd,
    };
  }

  private async fetchAuthorityFlags(
    tokenMint: string
  ): Promise<{ mintAuthorityRevoked?: boolean; freezeAuthorityRevoked?: boolean }> {
    try {
      const conn = rpcService.getConnection();
      const info = await this.withTimeout(
        conn.getParsedAccountInfo(new PublicKey(tokenMint)),
        FETCH_TIMEOUT_MS,
        null as any
      );
      const parsed: any = info?.value?.data;
      if (!parsed || parsed.program !== 'spl-token' || !parsed.parsed?.info) {
        return {};
      }
      const tokenInfo = parsed.parsed.info;
      return {
        mintAuthorityRevoked: tokenInfo.mintAuthority === null,
        freezeAuthorityRevoked: tokenInfo.freezeAuthority === null,
      };
    } catch {
      return {};
    }
  }

  private async fetchHolderConcentration(
    tokenMint: string
  ): Promise<{ top1Percent?: number; top10Percent?: number }> {
    try {
      const conn = rpcService.getConnection();
      const mintPubkey = new PublicKey(tokenMint);

      const [largest, supply] = await Promise.all([
        this.withTimeout(conn.getTokenLargestAccounts(mintPubkey), FETCH_TIMEOUT_MS, null as any),
        this.withTimeout(conn.getTokenSupply(mintPubkey), FETCH_TIMEOUT_MS, null as any),
      ]);

      const totalSupply = supply?.value?.uiAmount;
      const accounts: number[] = (largest?.value || []).map((a: any) => a?.uiAmount || 0);
      if (!totalSupply || totalSupply <= 0 || accounts.length === 0) {
        return {};
      }

      // NOTE: getTokenLargestAccounts returns up to 20 accounts and very
      // often includes the DEX liquidity pool itself as the single largest
      // "holder" — these signals are intentionally conservative and only
      // flagged at high thresholds, not proof of team/insider concentration
      // specifically.
      const top1Percent = (accounts[0] / totalSupply) * 100;
      const top10Percent = (accounts.slice(0, 10).reduce((s, a) => s + a, 0) / totalSupply) * 100;
      return { top1Percent, top10Percent };
    } catch {
      return {};
    }
  }

  private async analyze(tokenMint: string): Promise<TokenRiskAnalysis> {
    const [authorityFlags, dexStats, holderConcentration] = await Promise.all([
      this.fetchAuthorityFlags(tokenMint),
      this.fetchDexScreenerStats(tokenMint),
      this.fetchHolderConcentration(tokenMint),
    ]);

    const flags: string[] = [];
    let score = 0;

    if (authorityFlags.mintAuthorityRevoked === false) {
      score += 30;
      flags.push('Mint authority active — supply can be inflated at will');
    }
    if (authorityFlags.freezeAuthorityRevoked === false) {
      score += 20;
      flags.push('Freeze authority active — wallets can be frozen');
    }

    if (typeof dexStats.liquidityUsd === 'number') {
      if (dexStats.liquidityUsd < 3000) {
        score += 25;
        flags.push(`Very low liquidity ($${Math.round(dexStats.liquidityUsd).toLocaleString()})`);
      } else if (dexStats.liquidityUsd < 15000) {
        score += 10;
        flags.push(`Low liquidity ($${Math.round(dexStats.liquidityUsd).toLocaleString()})`);
      }
    } else {
      score += 8;
      flags.push('No liquidity data found on DexScreener');
    }

    if (typeof dexStats.ageMinutes === 'number') {
      if (dexStats.ageMinutes < 10) {
        score += 25;
        flags.push(`Extremely new pool (${Math.round(dexStats.ageMinutes)}m old)`);
      } else if (dexStats.ageMinutes < 60) {
        score += 15;
        flags.push(`New pool (${Math.round(dexStats.ageMinutes)}m old)`);
      } else if (dexStats.ageMinutes < 1440) {
        score += 5;
        flags.push('Pool under 24h old');
      }
    }

    if (typeof holderConcentration.top1Percent === 'number' && holderConcentration.top1Percent > 50) {
      score += 20;
      flags.push(`Top holder controls ${holderConcentration.top1Percent.toFixed(0)}% of supply`);
    }
    if (typeof holderConcentration.top10Percent === 'number' && holderConcentration.top10Percent > 25) {
      score += 10;
      flags.push(`Top 10 holders control ${holderConcentration.top10Percent.toFixed(0)}% of supply`);
    }

    let volumeExceedsMarketCap: boolean | undefined;
    if (typeof dexStats.volume24hUsd === 'number' && typeof dexStats.marketCapUsd === 'number' && dexStats.marketCapUsd > 0) {
      volumeExceedsMarketCap = dexStats.volume24hUsd > dexStats.marketCapUsd;
      if (volumeExceedsMarketCap) {
        const ratio = dexStats.volume24hUsd / dexStats.marketCapUsd;
        score += 10;
        flags.push(`24h volume is ${ratio.toFixed(1)}x market cap — possible wash trading`);
      }
    }

    score = Math.max(0, Math.min(100, score));

    let level: TokenRiskLevel;
    if (score >= 70) level = 'CRITICAL';
    else if (score >= 45) level = 'HIGH';
    else if (score >= 20) level = 'MEDIUM';
    else level = 'LOW';

    if (flags.length === 0) {
      flags.push('No major red flags detected in available data');
    }

    return {
      tokenMint,
      level,
      score,
      flags,
      mintAuthorityRevoked: authorityFlags.mintAuthorityRevoked,
      freezeAuthorityRevoked: authorityFlags.freezeAuthorityRevoked,
      liquidityUsd: dexStats.liquidityUsd,
      topHolderPercent: holderConcentration.top1Percent,
      top10HolderPercent: holderConcentration.top10Percent,
      topHoldersConcentrationPct: holderConcentration.top10Percent,
      ageMinutes: dexStats.ageMinutes,
      volume24hUsd: dexStats.volume24hUsd,
      marketCapUsd: dexStats.marketCapUsd,
      volumeExceedsMarketCap,
      pending: false,
      analyzedAt: Date.now(),
    };
  }
}

export const riskAnalysisService = new RiskAnalysisService();
