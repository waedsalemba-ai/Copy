import { db } from './db';
import { solPriceService } from './solPriceService';

export enum JupiterPriority {
  HIGH = 0,       // Execution quotes for authorized paper-trading decisions
  MEDIUM = 1,     // Position valuation / active-position monitoring
  LOW = 2,        // Dashboard price refresh
  BACKGROUND = 3, // Bulk token price discovery
}

export type JupiterRequestType = 'PRICE' | 'PRICE_BATCH' | 'QUOTE';

export interface JupiterExecutionQuote {
  outAmountRawUnits: number;
  priceImpactPct: number;
}

interface PriceCacheEntry {
  priceSol: number;
  usdPrice?: number;
  fetchedAt: number;
}

interface QueueItem<T = any> {
  id: string;
  type: JupiterRequestType;
  priority: JupiterPriority;
  key: string;
  mint?: string;
  mints?: string[];
  executor: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  enqueuedAt: number;
  timeoutMs: number;
}

const JUPITER_API_BASE = 'https://api.jup.ag';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_TIMEOUT_MS = 5000;
const PRICE_CACHE_TTL_MS = 10_000; // 10 seconds short-lived cache for market prices
const CONCURRENCY_LIMIT = 2;
const MIN_INTER_REQUEST_GAP_MS = 150;

export class JupiterRequestCoordinator {
  private static instance: JupiterRequestCoordinator;

  private requestCounter = 0;
  private queue: QueueItem[] = [];
  private activeCount = 0;
  private inFlightMap: Map<string, Promise<any>> = new Map();
  private priceCache: Map<string, PriceCacheEntry> = new Map();

  // 429 Cooldown state
  private globalCooldownUntil = 0;
  private backoffStep = 0;
  private lastRequestTime = 0;
  private processingScheduled = false;

  private constructor() {
    console.log('[Jupiter Coordinator] initialized');
    console.log(`[Jupiter Coordinator] concurrency=${CONCURRENCY_LIMIT}`);
    console.log('[Jupiter Coordinator] cache enabled');
  }

  public static getInstance(): JupiterRequestCoordinator {
    if (!JupiterRequestCoordinator.instance) {
      JupiterRequestCoordinator.instance = new JupiterRequestCoordinator();
    }
    return JupiterRequestCoordinator.instance;
  }

  public getInFlightCount(): number {
    return this.inFlightMap.size;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public isInCooldown(): boolean {
    return Date.now() < this.globalCooldownUntil;
  }

  public getCooldownRemainingMs(): number {
    return Math.max(0, this.globalCooldownUntil - Date.now());
  }

  /**
   * Primary entry point for token spot price lookup.
   * Utilizes cache -> in-flight deduplication -> priority queue -> Jupiter V3 API.
   */
  public async getTokenPrice(
    tokenMint: string,
    priority: JupiterPriority = JupiterPriority.LOW
  ): Promise<number | null> {
    if (!tokenMint || tokenMint === 'UNKNOWN') return null;

    if (tokenMint === SOL_MINT) {
      return 1.0;
    }

    // 1. Check local short-lived price cache
    const cached = this.priceCache.get(tokenMint);
    if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
      // console.log(`[Jupiter] cache hit for ${tokenMint.slice(0, 8)}`);
      return cached.priceSol;
    }

    // 2. Cooldown check: if cooling down, return stale cache if available, or null
    if (this.isInCooldown()) {
      return cached ? cached.priceSol : null;
    }

    // 3. In-flight request deduplication
    const dedupeKey = `price:${tokenMint}`;
    if (this.inFlightMap.has(dedupeKey)) {
      // console.log(`[Jupiter] deduplicated in-flight price request for ${tokenMint.slice(0, 8)}`);
      return this.inFlightMap.get(dedupeKey)!;
    }

    const promise = this.enqueueRequest<number | null>({
      type: 'PRICE',
      priority,
      key: dedupeKey,
      mint: tokenMint,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      executor: async (signal) => {
        const apiKey = db.getSettings().jupiterApiKey?.trim();
        const headers: Record<string, string> = {};
        if (apiKey) headers['x-api-key'] = apiKey;

        const res = await fetch(`${JUPITER_API_BASE}/price/v3?ids=${tokenMint},${SOL_MINT}`, {
          signal,
          headers,
        });

        if (!res.ok) {
          this.handleHttpError(res, `single fetch for ${tokenMint}`);
          return cached ? cached.priceSol : null;
        }

        const data = await res.json();
        const tokenUsd = parseFloat(data?.data?.[tokenMint]?.usdPrice ?? data?.[tokenMint]?.usdPrice);
        const solUsd = parseFloat(data?.data?.[SOL_MINT]?.usdPrice ?? data?.[SOL_MINT]?.usdPrice);

        if (solUsd > 0) {
          solPriceService.updateSolPriceUsd(solUsd);
        }

        if (tokenUsd > 0) {
          const currentSolUsd = solUsd > 0 ? solUsd : solPriceService.getSolPriceUsd();
          const priceSol = tokenUsd / currentSolUsd;
          if (priceSol > 0) {
            this.priceCache.set(tokenMint, { priceSol, usdPrice: tokenUsd, fetchedAt: Date.now() });
            return priceSol;
          }
        }

        return cached ? cached.priceSol : null;
      },
    });

    this.inFlightMap.set(dedupeKey, promise);
    promise.finally(() => this.inFlightMap.delete(dedupeKey));

    return promise;
  }

  /**
   * Batch price fetching for multiple token mints in a single Jupiter API call.
   */
  public async getBatchPrices(
    tokenMints: string[],
    priority: JupiterPriority = JupiterPriority.MEDIUM
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const uniqueMints = Array.from(
      new Set(tokenMints.filter((m) => m && m !== 'UNKNOWN' && m !== SOL_MINT))
    );

    if (uniqueMints.length === 0) return result;

    // Check cached items
    const missingMints: string[] = [];
    const now = Date.now();
    for (const mint of uniqueMints) {
      const cached = this.priceCache.get(mint);
      if (cached && now - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
        result.set(mint, cached.priceSol);
      } else {
        missingMints.push(mint);
      }
    }

    if (missingMints.length === 0 || this.isInCooldown()) {
      return result;
    }

    // Deduplicate in-flight batch requests for same set of mints
    const sortedMintsKey = [...missingMints].sort().join(',');
    const dedupeKey = `batch:${sortedMintsKey}`;

    if (this.inFlightMap.has(dedupeKey)) {
      const batchRes = await this.inFlightMap.get(dedupeKey);
      if (batchRes instanceof Map) {
        batchRes.forEach((v, k) => result.set(k, v));
      }
      return result;
    }

    const promise = this.enqueueRequest<Map<string, number>>({
      type: 'PRICE_BATCH',
      priority,
      key: dedupeKey,
      mints: missingMints,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      executor: async (signal) => {
        const batchResult = new Map<string, number>();
        const chunkSize = 50;

        for (let i = 0; i < missingMints.length; i += chunkSize) {
          if (this.isInCooldown()) break;
          const chunk = missingMints.slice(i, i + chunkSize);
          const ids = [...chunk, SOL_MINT].join(',');

          const apiKey = db.getSettings().jupiterApiKey?.trim();
          const headers: Record<string, string> = {};
          if (apiKey) headers['x-api-key'] = apiKey;

          const res = await fetch(`${JUPITER_API_BASE}/price/v3?ids=${ids}`, {
            signal,
            headers,
          });

          if (!res.ok) {
            this.handleHttpError(res, 'batch price fetch');
            break;
          }

          const data = await res.json();
          const solUsd = parseFloat(data?.data?.[SOL_MINT]?.usdPrice ?? data?.[SOL_MINT]?.usdPrice);
          if (solUsd > 0) {
            solPriceService.updateSolPriceUsd(solUsd);
          }

          const currentSolUsd = solUsd > 0 ? solUsd : solPriceService.getSolPriceUsd();

          for (const mint of chunk) {
            const tokenUsd = parseFloat(data?.data?.[mint]?.usdPrice ?? data?.[mint]?.usdPrice);
            if (tokenUsd > 0 && currentSolUsd > 0) {
              const priceSol = tokenUsd / currentSolUsd;
              this.priceCache.set(mint, { priceSol, usdPrice: tokenUsd, fetchedAt: Date.now() });
              batchResult.set(mint, priceSol);
            }
          }
        }

        console.log('[Jupiter] batch request completed');
        return batchResult;
      },
    });

    this.inFlightMap.set(dedupeKey, promise);
    promise.finally(() => this.inFlightMap.delete(dedupeKey));

    const batchRes = await promise;
    if (batchRes) {
      batchRes.forEach((v, k) => result.set(k, v));
    }

    return result;
  }

  /**
   * Execution quote fetching for paper-trading decisions.
   * Priority: ALWAYS HIGH.
   * NEVER returns stale or cached data — strictly requires a live, executable Jupiter roundtrip quote.
   */
  public async getExecutionQuote(
    inputMint: string,
    outputMint: string,
    amountRawUnits: number,
    slippageBps = 50
  ): Promise<JupiterExecutionQuote | null> {
    if (!(amountRawUnits > 0)) return null;

    // Execution quote ALWAYS has HIGH priority
    const priority = JupiterPriority.HIGH;
    const roundAmount = Math.round(amountRawUnits);
    const dedupeKey = `quote:${inputMint}:${outputMint}:${roundAmount}:${slippageBps}`;

    // Deduplicate in-flight execution quote requests
    if (this.inFlightMap.has(dedupeKey)) {
      return this.inFlightMap.get(dedupeKey)!;
    }

    // Check cooldown: If in 429 cooldown, return null immediately (BLOCK BUY cleanly)
    if (this.isInCooldown()) {
      console.warn('[Jupiter Coordinator] Execution quote blocked due to global 429 cooldown');
      return null;
    }

    const apiKey = db.getSettings().jupiterApiKey?.trim();
    if (!apiKey) {
      console.warn('[Jupiter Coordinator] Execution quote skipped: no Jupiter API key configured');
      return null;
    }

    const promise = this.enqueueRequest<JupiterExecutionQuote | null>({
      type: 'QUOTE',
      priority,
      key: dedupeKey,
      mint: outputMint,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      executor: async (signal) => {
        const url = `${JUPITER_API_BASE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${roundAmount}&slippageBps=${slippageBps}`;
        const res = await fetch(url, {
          signal,
          headers: { 'x-api-key': apiKey },
        });

        if (!res.ok) {
          this.handleHttpError(res, 'execution quote');
          return null;
        }

        const data = await res.json();
        const outAmountRawUnits = parseFloat(data?.outAmount);
        if (!(outAmountRawUnits > 0)) {
          console.warn('[Jupiter] execution quote returned no usable outAmount:', JSON.stringify(data).slice(0, 150));
          return null;
        }

        const priceImpactPct = parseFloat(data?.priceImpactPct) || 0;
        return { outAmountRawUnits, priceImpactPct };
      },
    });

    this.inFlightMap.set(dedupeKey, promise);
    promise.finally(() => this.inFlightMap.delete(dedupeKey));

    return promise;
  }

  /**
   * Enqueue a request in the priority queue.
   */
  private enqueueRequest<T>(params: {
    type: JupiterRequestType;
    priority: JupiterPriority;
    key: string;
    mint?: string;
    mints?: string[];
    executor: (signal: AbortSignal) => Promise<T>;
    timeoutMs: number;
  }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = `jup_req_${++this.requestCounter}`;

      const item: QueueItem<T> = {
        id: requestId,
        type: params.type,
        priority: params.priority,
        key: params.key,
        mint: params.mint,
        mints: params.mints,
        executor: params.executor,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        timeoutMs: params.timeoutMs,
      };

      if (params.priority === JupiterPriority.BACKGROUND || params.type === 'PRICE_BATCH') {
        console.log('[Jupiter] batch request queued');
      }

      this.queue.push(item);
      this.sortQueue();
      this.scheduleProcessing();
    });
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority; // HIGH (0) comes first
      }
      return a.enqueuedAt - b.enqueuedAt; // FIFO within same priority
    });
  }

  private scheduleProcessing(): void {
    if (this.processingScheduled) return;
    this.processingScheduled = true;
    setImmediate(() => this.processQueue());
  }

  private async processQueue(): Promise<void> {
    this.processingScheduled = false;

    if (this.queue.length === 0) return;

    if (this.activeCount >= CONCURRENCY_LIMIT) {
      return;
    }

    // Check global cooldown
    if (this.isInCooldown()) {
      // Evict/resolve null for non-HIGH requests while in cooldown
      const now = Date.now();
      const nextHighIndex = this.queue.findIndex((item) => item.priority === JupiterPriority.HIGH);

      if (nextHighIndex === -1) {
        // Drop non-HIGH priority requests during cooldown
        const dropped = this.queue.splice(0, this.queue.length);
        dropped.forEach((item) => item.resolve(null));
        return;
      }
    }

    // Enforce rate gap between requests
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    if (timeSinceLast < MIN_INTER_REQUEST_GAP_MS) {
      setTimeout(() => this.scheduleProcessing(), MIN_INTER_REQUEST_GAP_MS - timeSinceLast);
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.activeCount++;
    this.lastRequestTime = Date.now();

    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, item.timeoutMs);

    try {
      const result = await item.executor(controller.signal);
      clearTimeout(timer);
      const latencyMs = Date.now() - startTime;

      console.log(
        `[Jupiter Coordinator] requestId=${item.id} type=${item.type} priority=${JupiterPriority[item.priority]} mint=${item.mint || 'batch'} status=SUCCESS latencyMs=${latencyMs}`
      );

      item.resolve(result);
    } catch (err: any) {
      clearTimeout(timer);
      const latencyMs = Date.now() - startTime;
      const isAbort = err?.name === 'AbortError' || controller.signal.aborted;

      console.warn(
        `[Jupiter Coordinator] requestId=${item.id} type=${item.type} priority=${JupiterPriority[item.priority]} mint=${item.mint || 'batch'} status=${isAbort ? 'TIMED_OUT' : 'FAILED'} latencyMs=${latencyMs}`
      );

      item.resolve(null);
    } finally {
      this.activeCount--;
      this.scheduleProcessing();
    }
  }

  private handleHttpError(res: Response, context: string): void {
    if (res.status === 429) {
      console.warn(`[Jupiter] HTTP 429 during ${context}`);

      // Parse Retry-After if present
      const retryAfterHeader = res.headers.get('retry-after');
      let cooldownMs = 30_000;

      if (retryAfterHeader) {
        const parsedSec = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsedSec) && parsedSec > 0) {
          cooldownMs = parsedSec * 1000;
        }
      } else {
        // Exponential backoff
        this.backoffStep = Math.min(this.backoffStep + 1, 3);
        cooldownMs = Math.min(120_000, 30_000 * Math.pow(2, this.backoffStep - 1));
      }

      const wasInCooldown = this.isInCooldown();
      this.globalCooldownUntil = Date.now() + cooldownMs;

      if (!wasInCooldown) {
        console.warn(`[Jupiter Coordinator] entering cooldown (${Math.round(cooldownMs / 1000)}s)`);
        console.warn('[Jupiter Coordinator] non-critical requests paused');

        setTimeout(() => {
          console.log('[Jupiter Coordinator] cooldown ended');
          console.log('[Jupiter Coordinator] gradual recovery');
          this.backoffStep = 0;
        }, cooldownMs);
      }
    } else {
      console.warn(`[Jupiter] API HTTP ${res.status} ${res.statusText} during ${context}`);
    }
  }
}

export const jupiterCoordinator = JupiterRequestCoordinator.getInstance();
