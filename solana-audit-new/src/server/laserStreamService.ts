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
  private lastSeenSignatureByWallet = new Map<string, string>();
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
          this.handleLogNotification(address, logInfo.signature).catch((err) => {
            console.error(`[LaserStream] Failed to process ${logInfo.signature}:`, err);
          });
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
      const connection = rpcService.getConnection();
      await Promise.all(Array.from(this.monitoredWallets).map(async (address) => {
        try {
          const pubkey = new PublicKey(address);
          const sigInfos = await connection.getSignaturesForAddress(pubkey, { limit: 100 });
          const key = address.toLowerCase();
          const cursor = this.lastSeenSignatureByWallet.get(key);
          const cursorIndex = cursor ? sigInfos.findIndex((s) => s.signature === cursor) : -1;
          const unseen = (cursorIndex >= 0 ? sigInfos.slice(0, cursorIndex) : sigInfos)
            .filter((s) => !s.err)
            .reverse();
          for (const sigInfo of unseen) await this.handleLogNotification(address, sigInfo.signature);
          if (sigInfos.length > 0) {
            this.lastSeenSignatureByWallet.set(key, sigInfos[0].signature);
            if (cursor && cursorIndex < 0) {
              console.warn(`[LaserStream] Poll cursor gap for ${address}; processed latest ${sigInfos.length} signatures`);
            }
          }
        } catch {
          // Retain the previous cursor so transient failures are retried.
        }
      }));
    } catch {
      // Ignore polling errors
    } finally {
      this.isPolling = false;
    }
  }

  // --- Turning a log notification into a RawSolanaTransaction -------------

  private async handleLogNotification(walletAddress: string, signature: string): Promise<void> {
    const connection = rpcService.getConnection();
    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
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
