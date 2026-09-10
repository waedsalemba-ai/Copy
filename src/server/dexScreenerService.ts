export interface DexScreenerTokenData {
  liquidityUsd?: number;
  marketCapUsd?: number;
  ageMinutes?: number;
  volume24hUsd?: number;
  volumeM5Usd?: number;
  priceChangeM5Pct?: number;
  priceChangeH1Pct?: number;
  txnsM5Buys?: number;
  txnsM5Sells?: number;
  pairCreatedAt?: number;
  baseTokenSymbol?: string;
  pairAddress?: string;
}

interface CacheEntry {
  data: DexScreenerTokenData;
  timestamp: number;
}

const CACHE_TTL_MS = 30 * 1000; // 30 second cache to deduplicate simultaneous requests
const FETCH_TIMEOUT_MS = 3500;
const MAX_CACHE_ENTRIES = 1000;

class DexScreenerService {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<DexScreenerTokenData>>();

  public async getTokenData(tokenMint: string): Promise<DexScreenerTokenData> {
    if (!tokenMint || tokenMint === 'UNKNOWN' || tokenMint.startsWith('So11111111111111111111111111111111111111112')) {
      return {};
    }

    const cached = this.cache.get(tokenMint);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    const running = this.inFlight.get(tokenMint);
    if (running) {
      return running;
    }

    const fetchPromise = this.fetchFromApi(tokenMint)
      .then((data) => {
        this.cache.set(tokenMint, { data, timestamp: Date.now() });
        if (this.cache.size > MAX_CACHE_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        return data;
      })
      .finally(() => {
        this.inFlight.delete(tokenMint);
      });

    this.inFlight.set(tokenMint, fetchPromise);
    return fetchPromise;
  }

  private async fetchFromApi(tokenMint: string): Promise<DexScreenerTokenData> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) return {};

      const data = await res.json();
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      if (pairs.length === 0) return {};

      // Select the pair with highest liquidity
      const best = pairs.reduce((a: any, b: any) =>
        (b?.liquidity?.usd || 0) > (a?.liquidity?.usd || 0) ? b : a
      );

      const liquidityUsd =
        typeof best?.liquidity?.usd === 'number' ? best.liquidity.usd : undefined;
      const ageMinutes = best?.pairCreatedAt
        ? Math.max(0, (Date.now() - best.pairCreatedAt) / 60000)
        : undefined;
      const volume24hUsd =
        typeof best?.volume?.h24 === 'number' ? best.volume.h24 : undefined;
      const marketCapUsd =
        typeof best?.marketCap === 'number'
          ? best.marketCap
          : typeof best?.fdv === 'number'
          ? best.fdv
          : undefined;

      return {
        liquidityUsd,
        marketCapUsd,
        ageMinutes,
        volume24hUsd,
        volumeM5Usd: typeof best?.volume?.m5 === 'number' ? best.volume.m5 : undefined,
        priceChangeM5Pct: typeof best?.priceChange?.m5 === 'number' ? best.priceChange.m5 : undefined,
        priceChangeH1Pct: typeof best?.priceChange?.h1 === 'number' ? best.priceChange.h1 : undefined,
        txnsM5Buys: typeof best?.txns?.m5?.buys === 'number' ? best.txns.m5.buys : undefined,
        txnsM5Sells: typeof best?.txns?.m5?.sells === 'number' ? best.txns.m5.sells : undefined,
        pairCreatedAt: best?.pairCreatedAt,
        baseTokenSymbol: best?.baseToken?.symbol,
        pairAddress: best?.pairAddress,
      };
    } catch {
      return {};
    }
  }
}

export const dexScreenerService = new DexScreenerService();
