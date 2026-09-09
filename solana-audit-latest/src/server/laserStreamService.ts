import { EventEmitter } from 'events';
import { PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
import { RawSolanaTransaction, RawSolanaInstruction } from './dexAdapters/DexAdapter';
import { db } from './db';
import { eventBus, SystemEvents } from './eventBus';
import { deduplicator } from './deduplicator';
import { tradeClassifier } from './classifier';
import { positionEngine } from './positionEngine';
import { rpcService } from './rpcService';

export class LaserStreamService extends EventEmitter {
  private connected = false;
  private reconnectAttempts = 0;
  private maxReconnectDelayMs = 30000;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  // walletAddress -> RPC websocket `onLogs` subscription id
  private subscriptions = new Map<string, number>();
  private monitoredWallets = new Set<string>();
  private processedSignatures = new Set<string>();
  private inFlightSignatures = new Set<string>();
  private lastSeenSignatureByWallet = new Map<string, string>();
  private queue: Array<{ walletAddress: string; signature: string; attempts: number }> = [];
  private isProcessingQueue = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;

  constructor() {
    super();
    this.init();
  }

  private init() {
    this.connect();
    this.startHeartbeat();
  }

  public connect(): void {
    const settings = db.getSettings();
    this.connected = true;
    this.reconnectAttempts = 0;

    db.updateMetrics({
      laserstreamConnected: true,
      laserstreamEndpoint: settings.laserstreamEndpoint,
    });

    eventBus.emit(SystemEvents.CONNECTION_STATUS_CHANGED, {
      laserstreamConnected: true,
      rpcConnected: db.getMetrics().rpcConnected,
    });

    // Start listening: uses WebSocket on dedicated RPCs, or resilient HTTP polling
    // on public Solana clusters (since public clusters block WebSocket logs with HTTP 429).
    this.subscribeAllEnabledWallets();
  }

  public disconnect(): void {
    this.connected = false;
    this.stopPolling();
    this.unsubscribeAll();
    this.monitoredWallets.clear();
    db.updateMetrics({ laserstreamConnected: false });
    eventBus.emit(SystemEvents.CONNECTION_STATUS_CHANGED, {
      laserstreamConnected: false,
      rpcConnected: db.getMetrics().rpcConnected,
    });
  }

  public triggerReconnect(): void {
    this.disconnect();
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelayMs
    );
    this.reconnectAttempts++;
    db.updateMetrics({ reconnectCount: db.getMetrics().reconnectCount + 1 });

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.connected) {
        db.updateMetrics({
          laserstreamConnected: true,
        });
      }
    }, 5000);
  }

  // --- Wallet subscription management -------------------------------------

  public subscribeAllEnabledWallets(): void {
    db.getWallets()
      .filter((w) => w.enabled)
      .forEach((w) => this.subscribeWallet(w.address));
  }

  public subscribeWallet(address: string): void {
    if (!this.connected) return;
    this.monitoredWallets.add(address);

    const isPublic = rpcService.isPublicCluster();
    if (isPublic) {
      // Public Solana RPC endpoints do not support WebSocket logs subscriptions (they reject with HTTP 429).
      // We start lightweight HTTP polling instead.
      this.startPolling();
      return;
    }

    if (this.subscriptions.has(address)) return;
    try {
      const connection = rpcService.getConnection();
      const pubkey = new PublicKey(address);
      const subId = connection.onLogs(
        pubkey,
        (logInfo) => {
          if (logInfo.err) return; // ignore failed transactions
          this.enqueueSignature(address, logInfo.signature);
        },
        'confirmed'
      );
      this.subscriptions.set(address, subId);
    } catch (err) {
      console.warn(`[LaserStream] WebSocket subscription failed, falling back to HTTP polling for ${address}:`, err);
      this.startPolling();
    }
  }

  public unsubscribeWallet(address: string): void {
    this.monitoredWallets.delete(address);
    const subId = this.subscriptions.get(address);
    if (subId !== undefined) {
      this.subscriptions.delete(address);
      try {
        rpcService.getConnection().removeOnLogsListener(subId).catch(() => {});
      } catch {
        // Connection may already be torn down; nothing more to do.
      }
    }
    if (this.monitoredWallets.size === 0) {
      this.stopPolling();
    }
  }

  private unsubscribeAll(): void {
    Array.from(this.subscriptions.keys()).forEach((address) => this.unsubscribeWallet(address));
  }

  // --- HTTP polling fallback for public Solana RPC clusters -----------------

  private startPolling(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      this.pollWallets();
    }, 7000);
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async pollWallets(): Promise<void> {
    if (!this.connected || this.isPolling || this.monitoredWallets.size === 0) return;
    this.isPolling = true;
    try {
      for (const address of this.monitoredWallets) {
        try {
          const pubkey = new PublicKey(address);
          const sigInfos = await rpcService.getSignaturesForAddress(pubkey, { limit: 100 });
          const walletKey = address.toLowerCase();
          const cursor = this.lastSeenSignatureByWallet.get(walletKey);
          const cursorIndex = cursor ? sigInfos.findIndex((info) => info.signature === cursor) : -1;
          const unseen = (cursorIndex >= 0 ? sigInfos.slice(0, cursorIndex) : sigInfos).reverse();
          for (const sigInfo of unseen) {
            if (sigInfo.err) continue;
            this.enqueueSignature(address, sigInfo.signature);
          }
          if (sigInfos.length > 0) this.lastSeenSignatureByWallet.set(walletKey, sigInfos[0].signature);
        } catch {
          // Ignore transient wallet polling error
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch {
      // Ignore polling errors
    } finally {
      this.isPolling = false;
    }
  }

  // --- Rate-controlled signature queue & ingestion --------------------------

  private enqueueSignature(walletAddress: string, signature: string): void {
    const key = `${walletAddress.toLowerCase()}:${signature}`;
    if (!signature || this.processedSignatures.has(key) || this.inFlightSignatures.has(key)) {
      return;
    }
    if (deduplicator.isDuplicate(signature, walletAddress)) {
      return;
    }

    // Keep queue bounded to prevent memory backlog during extreme bursts
    if (this.queue.length >= 120) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.inFlightSignatures.delete(`${dropped.walletAddress.toLowerCase()}:${dropped.signature}`);
      }
    }

    this.inFlightSignatures.add(key);
    this.queue.push({ walletAddress, signature, attempts: 0 });
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) break;

        try {
          await this.handleLogNotification(item.walletAddress, item.signature);
          this.processedSignatures.add(`${item.walletAddress.toLowerCase()}:${item.signature}`);
          if (this.processedSignatures.size > 2000) {
            const [oldest] = this.processedSignatures;
            this.processedSignatures.delete(oldest);
          }
        } catch (err: any) {
          console.warn(`[LaserStream] Could not process ${item.signature.slice(0, 8)}...:`, err?.message || err);
        } finally {
          this.inFlightSignatures.delete(`${item.walletAddress.toLowerCase()}:${item.signature}`);
        }

        // Pacing delay between processing transactions to stay well below RPC rate limits
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  // --- Turning a log notification into a RawSolanaTransaction -------------

  private async handleLogNotification(walletAddress: string, signature: string): Promise<void> {
    const tx = await rpcService.getTransaction(signature);
    if (!tx || !tx.meta) return;

    const rawTx = this.buildRawTransaction(walletAddress, signature, tx);
    if (!rawTx) return;

    await this.ingestRawTransaction(rawTx);
  }

  private buildRawTransaction(
    walletAddress: string,
    signature: string,
    tx: VersionedTransactionResponse
  ): RawSolanaTransaction | null {
    const meta = tx.meta;
    if (!meta) return null;

    const accountKeys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: meta.loadedAddresses,
    });

    let walletIndex = -1;
    for (let i = 0; i < accountKeys.length; i++) {
      const key = accountKeys.get(i);
      if (key && key.toBase58() === walletAddress) {
        walletIndex = i;
        break;
      }
    }
    if (walletIndex === -1) return null;

    const WSOL_MINT = 'So11111111111111111111111111111111111111112';

    // Native lamport delta for the wallet's own system account. Note: for
    // swaps that route SOL through a wrapped-SOL (WSOL) associated token
    // account — which is most of them — this alone only captures the tx
    // fee, not the real trade notional. The actual amount lives in the
    // WSOL entry of preTokenBalances/postTokenBalances below.
    const nativeSolDelta =
      (meta.postBalances[walletIndex] ?? 0) / 1e9 - (meta.preBalances[walletIndex] ?? 0) / 1e9;

    // The RawSolanaTransaction schema only tracks a single pre/post token
    // balance pair. Real swaps (especially routed ones) can touch several
    // mints for this wallet, so pick the mint with the largest absolute
    // balance change as "the" token involved — but WSOL is excluded from
    // that competition and folded into the SOL side instead, since
    // wrap/unwrap is an implementation detail of the swap route, not the
    // traded asset. Without this, a swap's WSOL leg (which is often bigger,
    // ui-amount-wise, than the destination token) wins the "biggest delta"
    // pick and the code reports the wallet as having "bought/sold SOL"
    // instead of the actual token.
    const preBalances = (meta.preTokenBalances || []).filter((b) => b.owner === walletAddress);
    const postBalances = (meta.postTokenBalances || []).filter((b) => b.owner === walletAddress);
    const mints = new Set<string>([
      ...preBalances.map((b) => b.mint),
      ...postBalances.map((b) => b.mint),
    ]);

    let wsolDelta = 0;
    let bestMint: string | undefined;
    let bestDelta = -1;
    let bestPreAmount = 0;
    let bestPostAmount = 0;
    let bestDecimals = 6;

    mints.forEach((mint) => {
      const pre = preBalances.find((b) => b.mint === mint);
      const post = postBalances.find((b) => b.mint === mint);
      const preAmt = pre?.uiTokenAmount.uiAmount ?? 0;
      const postAmt = post?.uiTokenAmount.uiAmount ?? 0;
      const delta = postAmt - preAmt;

      if (mint === WSOL_MINT) {
        wsolDelta += delta;
        return;
      }

      if (Math.abs(delta) > bestDelta) {
        bestDelta = Math.abs(delta);
        bestMint = mint;
        bestPreAmount = preAmt;
        bestPostAmount = postAmt;
        bestDecimals = post?.uiTokenAmount.decimals ?? pre?.uiTokenAmount.decimals ?? 6;
      }
    });

    // True SOL movement = native lamports (fee/rent) + any WSOL wrap/unwrap.
    const preSolBalance = 0;
    const postSolBalance = nativeSolDelta + wsolDelta;

    const instructions: RawSolanaInstruction[] = tx.transaction.message.compiledInstructions.map(
      (ix) => ({
        programId: accountKeys.get(ix.programIdIndex)?.toBase58() || 'UNKNOWN',
        data: Buffer.from(ix.data).toString('base64'),
        keys: ix.accountKeyIndexes.map((idx) => ({
          pubkey: accountKeys.get(idx)?.toBase58() || 'UNKNOWN',
          isSigner: false,
          isWritable: false,
        })),
      })
    );

    return {
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime || Math.floor(Date.now() / 1000),
      walletAddress,
      instructions,
      preSolBalance,
      postSolBalance,
      preTokenBalance: bestMint
        ? { mint: bestMint, amount: bestPreAmount, decimals: bestDecimals }
        : undefined,
      postTokenBalance: bestMint
        ? { mint: bestMint, amount: bestPostAmount, decimals: bestDecimals }
        : undefined,
      logMessages: meta.logMessages || undefined,
    };
  }

  /**
   * Primary Entry Point for Ingested Transactions from LaserStream stream
   */
  public async ingestRawTransaction(tx: RawSolanaTransaction): Promise<boolean> {
    if (!this.connected) return false;

    const metrics = db.getMetrics();
    db.updateMetrics({
      totalTransactionsProcessed: metrics.totalTransactionsProcessed + 1,
      lastSlot: tx.slot,
      lastSignature: tx.signature,
    });

    // Step 1: Idempotency & Deduplication Check
    if (deduplicator.isDuplicate(tx.signature, tx.walletAddress)) {
      console.log(`[Deduplicator] Ignored duplicate transaction: ${tx.signature}`);
      return false;
    }
    deduplicator.markProcessed(tx.signature, tx.walletAddress);

    // Step 2: Trade Classification Pipeline (The Authoritative Single Pipeline)
    const canonicalEvent = await tradeClassifier.classifyTransaction(tx);

    if (canonicalEvent.action === 'UNKNOWN') {
      db.updateMetrics({ unknownCount: metrics.unknownCount + 1 });
    }

    // Step 3: Update Position Engine
    positionEngine.processTrade(canonicalEvent);

    // Step 4: Database Persistence
    db.addTrade(canonicalEvent);

    // Update global system metrics
    const currentMetrics = db.getMetrics();
    db.updateMetrics({
      totalTradesDetected: currentMetrics.totalTradesDetected + 1,
      buyCount: canonicalEvent.action === 'BUY' ? currentMetrics.buyCount + 1 : currentMetrics.buyCount,
      sellCount: canonicalEvent.action === 'SELL' ? currentMetrics.sellCount + 1 : currentMetrics.sellCount,
      avgDetectionLatencyMs: Math.round(
        (currentMetrics.avgDetectionLatencyMs * 4 + canonicalEvent.detectionLatencyMs) / 5
      ),
      maxDetectionLatencyMs: Math.max(
        currentMetrics.maxDetectionLatencyMs,
        canonicalEvent.detectionLatencyMs
      ),
    });

    // Step 5: Emit onto Internal Event Bus
    eventBus.emit(SystemEvents.TRADE_DETECTED, canonicalEvent);

    return true;
  }
}

export const laserStreamService = new LaserStreamService();
