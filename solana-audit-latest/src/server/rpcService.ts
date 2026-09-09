import { Connection, PublicKey, type VersionedTransactionResponse, type ConfirmedSignatureInfo } from '@solana/web3.js';
import { db } from './db';
import { config } from './config';

// Rate limiter queue for outgoing RPC requests to prevent burst 429 errors
class RpcRateLimiter {
  private queue: (() => Promise<void>)[] = [];
  private activeCount = 0;
  private maxConcurrency = 2; // Maximum 2 concurrent RPC calls
  private minIntervalMs = 150; // At least 150ms between initiating RPC calls
  private lastRequestTime = 0;

  public async acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      this.queue.push(async () => {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minIntervalMs) {
          await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
        }
        this.lastRequestTime = Date.now();
        this.activeCount++;
        resolve(() => {
          this.activeCount--;
          this.processNext();
        });
      });
      this.processNext();
    });
  }

  private processNext(): void {
    if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

// Protect against @solana/web3.js hardcoded console.error('ws error:', err.message)
// when connecting to public Solana RPC clusters (which reject WebSocket subscriptions with 429)
if (Connection.prototype && !(Connection.prototype as any)._wsErrorPatched) {
  const originalWsOnError = (Connection.prototype as any)._wsOnError;
  (Connection.prototype as any)._wsOnError = function (err: any) {
    this._rpcWebSocketConnected = false;
    const msg = err?.message || String(err || '');
    if (msg.includes('429') || msg.includes('Unexpected server response')) {
      // Swallowed safely without polluting stderr: public Solana RPC clusters do not support WebSocket logs
      return;
    }
    if (originalWsOnError) {
      originalWsOnError.call(this, err);
    }
  };
  (Connection.prototype as any)._wsErrorPatched = true;
}

interface TokenInfo {
  symbol: string;
  decimals: number;
  name: string;
  priceSol: number;
}

type StaticTokenMeta = Pick<TokenInfo, 'symbol' | 'decimals' | 'name'>;

interface EndpointHealth {
  url: string;
  latencyMs: number;
  healthy: boolean;
  consecutiveFailures: number;
  lastSlot: number;
  lastCheckedAt: number;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const KNOWN_TOKENS: Record<string, TokenInfo> = {
  // SOL
  'So11111111111111111111111111111111111111112': {
    symbol: 'SOL',
    decimals: 9,
    name: 'Wrapped SOL',
    priceSol: 1.0,
  },
  // BONK
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': {
    symbol: 'BONK',
    decimals: 5,
    name: 'Bonk',
    priceSol: 0.000000185,
  },
  // WIF
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcJM': {
    symbol: 'WIF',
    decimals: 6,
    name: 'dogwifhat',
    priceSol: 0.0125,
  },
  // POPCAT
  '7GCihgR83WXR52DBM2332gS5eD9B84CxsGg5m3Jmpump': {
    symbol: 'POPCAT',
    decimals: 6,
    name: 'Popcat',
    priceSol: 0.0052,
  },
  // JUP
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': {
    symbol: 'JUP',
    decimals: 6,
    name: 'Jupiter',
    priceSol: 0.0068,
  },
  // RAY
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': {
    symbol: 'RAY',
    decimals: 6,
    name: 'Raydium',
    priceSol: 0.0112,
  },
  // RENDER
  'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof': {
    symbol: 'RENDER',
    decimals: 8,
    name: 'Render Token',
    priceSol: 0.038,
  },
  // USDC
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
    priceSol: 0.00687,
  },
};

// How long a fetched price is trusted before we consider it stale and go fetch
// again. Must be well under PRICE_REFRESH_INTERVAL_MS in paperTradingService
// (20s) or every mark-to-market tick would just re-serve the same cached
// number, which is what was silently happening before (see getTokenMetadata).
const PRICE_TTL_MS = 12_000;
const PRICE_FETCH_TIMEOUT_MS = 2_500;
// The KNOWN_TOKENS seed prices are only a cold-start fallback — real prices
// move constantly, so even "known" tokens must be re-fetched, not pinned
// forever. SOL is the one legitimate exception (it's priced in itself).
const SEED_PRICE_TTL_MS = 0;
const RPC_HEALTH_CHECK_INTERVAL_MS = 30_000;
const RPC_HEALTH_CHECK_TIMEOUT_MS = 2_500;
const RPC_CALL_TIMEOUT_MS = 4_000;

export class RpcService {
  private staticMetaCache = new Map<string, StaticTokenMeta>();
  private priceCache = new Map<string, { priceSol: number; fetchedAt: number }>();
  private inFlight = new Map<string, Promise<TokenInfo>>();

  private connections = new Map<string, Connection>();
  private endpointHealth = new Map<string, EndpointHealth>();
  private endpointCooldown = new Map<string, number>();
  private rateLimiter = new RpcRateLimiter();

  // Immutable cache for confirmed transaction responses to avoid repeated network hits
  private txCache = new Map<string, { tx: VersionedTransactionResponse; cachedAt: number }>();
  private inFlightTxs = new Map<string, Promise<VersionedTransactionResponse | null>>();

  private activeUrl: string | null = null;
  private lastHealthCheckAt = 0;
  private healthCheckPromise: Promise<void> | null = null;

  constructor() {
    // Seed known tokens: symbol/decimals/name are structural and safe to cache
    // indefinitely, but priceSol is a live market value, so it's seeded as
    // already-stale (fetchedAt: 0) except SOL, which is always exactly 1 SOL.
    Object.entries(KNOWN_TOKENS).forEach(([mint, info]) => {
      this.staticMetaCache.set(mint, { symbol: info.symbol, decimals: info.decimals, name: info.name });
      this.priceCache.set(mint, {
        priceSol: info.priceSol,
        fetchedAt: mint === SOL_MINT ? Infinity : SEED_PRICE_TTL_MS,
      });
    });
  }

  // ---------------------------------------------------------------------
  // RPC connection management with multi-endpoint failover
  // ---------------------------------------------------------------------

  // settings.rpcUrl may itself contain a comma-separated list of endpoints
  // (in addition to config.rpcFallbackUrls from the environment) — this stays
  // backward compatible with a plain single-URL string.
  private getConfiguredEndpoints(): string[] {
    const settings = db.getSettings();
    const fromSettings = (settings.rpcUrl || '').split(',').map((u) => u.trim()).filter(Boolean);
    const merged = [...fromSettings, ...config.rpcFallbackUrls, 'https://api.mainnet-beta.solana.com'];
    const deduped = Array.from(new Set(merged));
    return deduped.length > 0 ? deduped : ['https://api.mainnet-beta.solana.com'];
  }

  private getOrCreateConnection(url: string): Connection {
    let conn = this.connections.get(url);
    if (!conn) {
      conn = new Connection(url, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 5000,
        wsEndpoint: url.replace(/^http/, 'ws'),
      });
      this.connections.set(url, conn);
    }
    return conn;
  }

  // Ranks configured endpoints by last-known latency (healthy first), falling
  // back to declared order for endpoints we haven't measured yet.
  // Endpoints currently under a 429 cooldown are deprioritized.
  private rankedEndpoints(): string[] {
    const urls = this.getConfiguredEndpoints();
    const now = Date.now();
    return [...urls].sort((a, b) => {
      const cooldownA = (this.endpointCooldown.get(a) || 0) > now;
      const cooldownB = (this.endpointCooldown.get(b) || 0) > now;
      if (cooldownA !== cooldownB) {
        return cooldownA ? 1 : -1;
      }

      const ha = this.endpointHealth.get(a);
      const hb = this.endpointHealth.get(b);
      const scoreA = ha ? (ha.healthy ? ha.latencyMs : Infinity) : urls.indexOf(a);
      const scoreB = hb ? (hb.healthy ? hb.latencyMs : Infinity) : urls.indexOf(b);
      return scoreA - scoreB;
    });
  }

  // Races every configured endpoint's getSlot() and records latency/health for
  // each. Runs at most once per RPC_HEALTH_CHECK_INTERVAL_MS (unless forced)
  // so hot-path calls never pay the cost of a full race — they just read
  // whichever endpoint the last race found fastest.
  private async refreshEndpointHealth(force = false): Promise<void> {
    const urls = this.getConfiguredEndpoints();
    const now = Date.now();

    if (!force && this.activeUrl && now - this.lastHealthCheckAt < RPC_HEALTH_CHECK_INTERVAL_MS) {
      return;
    }
    if (this.healthCheckPromise) {
      return this.healthCheckPromise;
    }

    this.healthCheckPromise = (async () => {
      this.lastHealthCheckAt = now;

      const results = await Promise.allSettled(
        urls.map(async (url) => {
          const start = Date.now();
          const conn = this.getOrCreateConnection(url);
          const slot = await Promise.race([
            conn.getSlot(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`RPC health check timeout (${RPC_HEALTH_CHECK_TIMEOUT_MS}ms)`)), RPC_HEALTH_CHECK_TIMEOUT_MS)
            ),
          ]);
          return { url, latencyMs: Date.now() - start, slot };
        })
      );

      results.forEach((r, i) => {
        const url = urls[i];
        const prev = this.endpointHealth.get(url);
        if (r.status === 'fulfilled') {
          this.endpointHealth.set(url, {
            url,
            latencyMs: r.value.latencyMs,
            healthy: true,
            consecutiveFailures: 0,
            lastSlot: r.value.slot,
            lastCheckedAt: now,
          });
        } else {
          this.endpointHealth.set(url, {
            url,
            latencyMs: prev?.latencyMs ?? Infinity,
            healthy: false,
            consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
            lastSlot: prev?.lastSlot ?? 0,
            lastCheckedAt: now,
          });
        }
      });

      const ranked = this.rankedEndpoints();
      if (ranked.length > 0) {
        this.activeUrl = ranked[0];
      }
    })();

    try {
      await this.healthCheckPromise;
    } finally {
      this.healthCheckPromise = null;
    }
  }

  // Public + cached: callers that need a live websocket subscription (onLogs)
  // must keep reusing the *same* Connection instance per URL, since each new
  // one opens (and never closes) its own socket. Returns whichever endpoint
  // last measured fastest; a background health race keeps that choice current
  // without blocking this call.
  public getConnection(): Connection {
    const urls = this.getConfiguredEndpoints();
    if (!this.activeUrl || !urls.includes(this.activeUrl)) {
      this.activeUrl = urls[0];
    }
    if (urls.length > 1 && Date.now() - this.lastHealthCheckAt > RPC_HEALTH_CHECK_INTERVAL_MS) {
      this.refreshEndpointHealth().catch(() => {});
    }
    return this.getOrCreateConnection(this.activeUrl);
  }

  public getEndpointHealth(): EndpointHealth[] {
    return this.getConfiguredEndpoints().map((url) => {
      const h = this.endpointHealth.get(url);
      return h ?? { url, latencyMs: Infinity, healthy: false, consecutiveFailures: 0, lastSlot: 0, lastCheckedAt: 0 };
    });
  }

  public isPublicCluster(url?: string): boolean {
    const target = url || this.activeUrl || db.getSettings().rpcUrl;
    return target.includes('api.mainnet-beta.solana.com') || target.includes('solana.com');
  }

  public validateAddress(address: string): boolean {
    try {
      if (!address || address.length < 32 || address.length > 44) return false;
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  public async testRpcConnection(): Promise<{ ok: boolean; latencyMs: number; slot?: number; error?: string }> {
    const start = Date.now();
    try {
      await this.refreshEndpointHealth(true);
      const active = this.activeUrl ? this.endpointHealth.get(this.activeUrl) : undefined;

      if (!active || !active.healthy) {
        throw new Error(active ? 'All configured RPC endpoints are unreachable' : 'No RPC endpoint configured');
      }

      db.updateMetrics({
        rpcConnected: true,
        rpcLatencyMs: active.latencyMs,
        lastSlot: active.lastSlot,
      });

      return { ok: true, latencyMs: active.latencyMs, slot: active.lastSlot };
    } catch (err: any) {
      db.updateMetrics({
        rpcConnected: false,
        rpcErrors: db.getMetrics().rpcErrors + 1,
      });
      return { ok: false, latencyMs: Date.now() - start, error: err?.message || 'RPC Connection Failed' };
    }
  }

  // Core RPC execution wrapper with rate limiting, retry backoff on 429, and endpoint failover
  public async executeRpcCall<T>(
    operation: (conn: Connection) => Promise<T>,
    description = 'RPC call',
    maxRetries = 3
  ): Promise<T> {
    const release = await this.rateLimiter.acquire();
    try {
      let lastError: any = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const endpoints = this.rankedEndpoints();
        const now = Date.now();
        // Prefer endpoint not in cooldown
        let targetUrl = endpoints.find((u) => (this.endpointCooldown.get(u) || 0) <= now) || endpoints[0] || 'https://api.mainnet-beta.solana.com';

        try {
          const conn = this.getOrCreateConnection(targetUrl);
          const result = await Promise.race([
            operation(conn),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`${description} timeout (${RPC_CALL_TIMEOUT_MS}ms)`)), RPC_CALL_TIMEOUT_MS)
            ),
          ]);
          this.activeUrl = targetUrl;
          return result;
        } catch (err: any) {
          lastError = err;
          const msg = err?.message || String(err || '');
          const is429 = msg.includes('429') || msg.toLowerCase().includes('too many requests');

          if (is429) {
            // Apply 3s cooldown to this endpoint so other endpoints can be tried
            this.endpointCooldown.set(targetUrl, Date.now() + 3000);
            db.updateMetrics({ rpcErrors: db.getMetrics().rpcErrors + 1 });

            if (attempt < maxRetries) {
              const backoff = Math.min(4000, 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 300));
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
          } else {
            if (attempt < maxRetries) {
              await new Promise((r) => setTimeout(r, 250 + attempt * 200));
              continue;
            }
          }
        }
      }

      throw lastError;
    } finally {
      release();
    }
  }

  /**
   * Resilient transaction fetcher with in-flight coalescing, caching, rate-limiting, and 429 backoff
   */
  public async getTransaction(
    signature: string,
    maxRetries = 3
  ): Promise<VersionedTransactionResponse | null> {
    if (!signature) return null;

    // 1. Return from memory cache if recently fetched (confirmed transactions are immutable)
    const cached = this.txCache.get(signature);
    if (cached && Date.now() - cached.cachedAt < 60_000) {
      return cached.tx;
    }

    // 2. Coalesce concurrent requests for the exact same signature
    const pending = this.inFlightTxs.get(signature);
    if (pending) {
      return pending;
    }

    const fetchPromise = (async () => {
      try {
        const tx = await this.executeRpcCall(
          (conn) =>
            conn.getTransaction(signature, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            }),
          `getTransaction(${signature.slice(0, 8)})`,
          maxRetries
        );

        if (tx) {
          if (this.txCache.size > 500) {
            const firstKey = this.txCache.keys().next().value;
            if (firstKey) this.txCache.delete(firstKey);
          }
          this.txCache.set(signature, { tx, cachedAt: Date.now() });
        }

        return tx || null;
      } catch (err: any) {
        const is429 = err?.message?.includes('429') || err?.message?.toLowerCase().includes('too many requests');
        if (is429) {
          console.warn(`[RpcService] Rate limit (429) sustained while fetching ${signature.slice(0, 8)}... Backed off gracefully.`);
        }
        return null;
      }
    })().finally(() => {
      this.inFlightTxs.delete(signature);
    });

    this.inFlightTxs.set(signature, fetchPromise);
    return fetchPromise;
  }

  /**
   * Resilient getSignaturesForAddress through rate limiter
   */
  public async getSignaturesForAddress(
    pubkey: PublicKey,
    options?: { limit?: number; before?: string; until?: string }
  ): Promise<ConfirmedSignatureInfo[]> {
    try {
      return await this.executeRpcCall(
        (conn) => conn.getSignaturesForAddress(pubkey, options),
        `getSignaturesForAddress(${pubkey.toBase58().slice(0, 6)})`,
        2
      );
    } catch {
      return [];
    }
  }

  public async getSolBalance(address: string): Promise<number> {
    if (!this.validateAddress(address)) return 0;

    const pubkey = new PublicKey(address);
    // Try endpoints fastest-first; fall over to the next one on error or
    // timeout instead of failing the whole call because one RPC hiccuped.
    for (const url of this.rankedEndpoints()) {
      try {
        const conn = this.getOrCreateConnection(url);
        const balanceLamports = await Promise.race([
          conn.getBalance(pubkey),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`RPC call timeout (${RPC_CALL_TIMEOUT_MS}ms)`)), RPC_CALL_TIMEOUT_MS)
          ),
        ]);
        this.activeUrl = url;
        return balanceLamports / 1e9;
      } catch {
        continue;
      }
    }
    return 0;
  }

  // ---------------------------------------------------------------------
  // Token metadata + price, with TTL-based refresh and request de-duping
  // ---------------------------------------------------------------------

  private isPriceFresh(tokenMint: string): boolean {
    const cached = this.priceCache.get(tokenMint);
    if (!cached) return false;
    if (tokenMint === SOL_MINT) return true;
    return Date.now() - cached.fetchedAt < PRICE_TTL_MS;
  }

  public async getTokenMetadata(tokenMint: string): Promise<TokenInfo> {
    if (!tokenMint || tokenMint === 'UNKNOWN') {
      return { symbol: 'UNKNOWN', decimals: 6, name: 'Unknown Token', priceSol: 0 };
    }

    const staticMeta = this.staticMetaCache.get(tokenMint);
    if (staticMeta && this.isPriceFresh(tokenMint)) {
      return { ...staticMeta, priceSol: this.priceCache.get(tokenMint)!.priceSol };
    }

    // De-duplicate concurrent refreshes for the same mint — e.g. several open
    // positions across different wallets on the same token all refreshing on
    // the same 20s tick previously meant N redundant network round trips for
    // identical data. Now they share one in-flight fetch.
    const pending = this.inFlight.get(tokenMint);
    if (pending) return pending;

    const fetchPromise = this.resolveTokenInfo(tokenMint, staticMeta).finally(() => {
      this.inFlight.delete(tokenMint);
    });
    this.inFlight.set(tokenMint, fetchPromise);
    return fetchPromise;
  }

  // Fetches prices for many mints in parallel (deduped) instead of the
  // caller awaiting them one at a time in a loop.
  public async getPricesBatch(tokenMints: string[]): Promise<Map<string, TokenInfo>> {
    const uniqueMints = Array.from(new Set(tokenMints.filter((m) => m && m !== 'UNKNOWN')));
    const results = await Promise.allSettled(uniqueMints.map((mint) => this.getTokenMetadata(mint)));

    const out = new Map<string, TokenInfo>();
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        out.set(uniqueMints[i], r.value);
      }
    });
    return out;
  }

  public async getJupiterPricesBatch(tokenMints: string[]): Promise<Map<string, number>> {
    const uniqueMints = Array.from(new Set(tokenMints.filter((mint) => mint && mint !== 'UNKNOWN')));
    const results = await Promise.allSettled(uniqueMints.map(async (mint) => [mint, await this.getJupiterPrice(mint)] as const));
    const out = new Map<string, number>();
    results.forEach((result) => {
      if (result.status === 'fulfilled' && result.value[1] !== null && result.value[1] > 0) {
        out.set(result.value[0], result.value[1]);
      }
    });
    return out;
  }

  private async resolveTokenInfo(tokenMint: string, staticMeta: StaticTokenMeta | undefined): Promise<TokenInfo> {
    let info: TokenInfo | null = null;

    if (staticMeta) {
      // Symbol/decimals/name already known — only the price needs refreshing,
      // so use the lighter/faster Jupiter price endpoint first.
      const price = await this.fetchPriceFromJupiter(tokenMint);
      if (price !== null) {
        info = { ...staticMeta, priceSol: price };
      } else {
        const dex = await this.fetchFromDexScreener(tokenMint);
        info = dex ? { ...staticMeta, priceSol: dex.priceSol } : null;
      }
    } else {
      // First time seeing this mint — need full metadata (symbol/decimals/name),
      // which only DexScreener gives us here.
      info = await this.fetchFromDexScreener(tokenMint);
      if (!info) {
        const price = await this.fetchPriceFromJupiter(tokenMint);
        if (price !== null) {
          info = { symbol: 'UNKNOWN', decimals: 6, name: 'Unknown Token', priceSol: price };
        }
      }
    }

    if (!info) {
      // Network failure on every source: keep serving the last known price
      // rather than snapping to a placeholder, if we have one.
      const lastKnownPrice = this.priceCache.get(tokenMint)?.priceSol;
      if (staticMeta && lastKnownPrice !== undefined) {
        return { ...staticMeta, priceSol: lastKnownPrice };
      }
      const shortMint = tokenMint.length > 8 ? `${tokenMint.slice(0, 4)}...${tokenMint.slice(-4)}` : tokenMint;
      info = {
        symbol: shortMint.toUpperCase(),
        decimals: 6,
        name: `Token ${shortMint}`,
        priceSol: lastKnownPrice ?? 0.001,
      };
    }

    this.staticMetaCache.set(tokenMint, { symbol: info.symbol, decimals: info.decimals, name: info.name });
    this.priceCache.set(tokenMint, { priceSol: info.priceSol, fetchedAt: Date.now() });
    return info;
  }

  public async getJupiterPrice(tokenMint: string): Promise<number | null> {
    return this.fetchPriceFromJupiter(tokenMint);
  }

  // Fast path: Jupiter's price API is purpose-built for Solana token pricing
  // and returns a single number with a small payload — cheaper and typically
  // lower-latency than pulling a full DexScreener pair list just to re-read
  // one field.
  private async fetchPriceFromJupiter(tokenMint: string): Promise<number | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PRICE_FETCH_TIMEOUT_MS);
      const res = await fetch(`https://lite-api.jup.ag/price/v2?ids=${tokenMint}&vsToken=${SOL_MINT}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) return null;

      const data = await res.json();
      const price = parseFloat(data?.data?.[tokenMint]?.price);
      return price > 0 ? price : null;
    } catch {
      return null;
    }
  }

  private async fetchFromDexScreener(tokenMint: string): Promise<TokenInfo | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PRICE_FETCH_TIMEOUT_MS);
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) return null;

      const data = await res.json();
      const pairs: any[] = data?.pairs || [];
      if (pairs.length === 0) return null;

      // Previously this just took pairs[0].priceNative unconditionally, which
      // is only actually a SOL price when the pair's quote side is SOL. For
      // tokens whose deepest/first pair is USDC-quoted (or anything else),
      // that silently mislabeled a USDC price as a SOL price. Prefer an
      // actual SOL-quoted pair for this mint; if none exists, fall back to a
      // USD cross-rate instead of a wrong unit.
      const matchesMint = (p: any) => p.baseToken?.address?.toLowerCase() === tokenMint.toLowerCase();
      const solQuoted = pairs.find((p) => matchesMint(p) && p.quoteToken?.address === SOL_MINT);
      const anyMatch = solQuoted || pairs.find(matchesMint) || pairs[0];
      if (!anyMatch) return null;

      const tokenObj = matchesMint(anyMatch) ? anyMatch.baseToken : anyMatch.quoteToken;
      if (!tokenObj?.symbol) return null;

      let priceSol: number | null = null;
      if (anyMatch.quoteToken?.address === SOL_MINT) {
        const priceNative = parseFloat(anyMatch.priceNative);
        if (priceNative > 0) priceSol = priceNative;
      }
      if (priceSol === null) {
        const priceUsd = parseFloat(anyMatch.priceUsd);
        if (priceUsd > 0 && config.solPriceUsd > 0) {
          priceSol = priceUsd / config.solPriceUsd;
        }
      }
      if (priceSol === null) return null;

      return {
        symbol: tokenObj.symbol.toUpperCase(),
        name: tokenObj.name || tokenObj.symbol,
        decimals: 6,
        priceSol,
      };
    } catch {
      return null;
    }
  }
}

export const rpcService = new RpcService();
