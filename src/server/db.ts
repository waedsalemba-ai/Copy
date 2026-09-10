import fs from 'fs';
import path from 'path';
import {
  TraderWallet,
  CanonicalTradeEvent,
  Position,
  SystemAlert,
  SystemMetrics,
  AppSettings,
  CopyTradeSettings,
  BuyEntrySettings,
  PaperPosition,
  PaperTrade,
  PaperAccount,
  DiscoveredWallet,
} from '../types';
import { config } from './config';
import {
  syncWalletToFirestoreServer,
  deleteWalletFromFirestoreServer,
  syncSettingsToFirestoreServer,
  syncCopyTradeSettingsToFirestoreServer,
  syncPaperAccountToFirestoreServer,
  syncPaperTradeToFirestoreServer,
  syncPaperPositionToFirestoreServer,
  loadInitialDataFromFirestoreServer,
  logUserEntryServer,
} from './firebaseServer';

interface DbSchema {
  wallets: TraderWallet[];
  trades: CanonicalTradeEvent[];
  positions: Position[];
  alerts: SystemAlert[];
  settings: AppSettings;
  metrics: SystemMetrics;
  copyTradeSettings: CopyTradeSettings;
  buyEntrySettings: BuyEntrySettings;
  paperAccount: PaperAccount;
  paperPositions: PaperPosition[];
  paperTrades: PaperTrade[];
  discoveredWallets?: DiscoveredWallet[];
}

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

// Closed positions/paper-positions accumulated forever (unlike trades,
// alerts, and paperTrades, which were already capped) — on a long-running
// instance that's both an unbounded memory leak and, combined with the
// synchronous full-file rewrite below, a growing amount of blocking disk
// I/O on every single save. OPEN positions are never trimmed regardless of
// this cap; only the oldest CLOSED ones are dropped once it's exceeded.
const MAX_CLOSED_POSITIONS = 1000;
const MAX_CLOSED_PAPER_POSITIONS = 1000;

const INITIAL_WALLETS: TraderWallet[] = [];

const INITIAL_METRICS: SystemMetrics = {
  laserstreamConnected: true,
  liveStreamRunning: true,
  paperTradingRunning: true,
  laserstreamEndpoint: config.laserstreamEndpoint,
  rpcConnected: true,
  rpcLatencyMs: 0,
  lastSlot: 0,
  lastSignature: '',
  totalTransactionsProcessed: 0,
  totalTradesDetected: 0,
  buyCount: 0,
  sellCount: 0,
  unknownCount: 0,
  duplicateCount: 0,
  decoderErrors: 0,
  rpcErrors: 0,
  avgDetectionLatencyMs: 0,
  maxDetectionLatencyMs: 0,
  wsClientCount: 0,
  reconnectCount: 0,
  activeWalletsCount: 0,
};

const INITIAL_SETTINGS: AppSettings = {
  liveApiKey: config.liveApiKey,
  primaryRpcUrl: config.primaryRpcUrl,
  secondaryRpcUrl: config.secondaryRpcUrl,
  primaryLaserstreamEndpoint: config.primaryLaserstreamEndpoint,
  primaryLaserstreamApiKey: config.primaryLaserstreamApiKey,
  secondaryLaserstreamEndpoint: config.secondaryLaserstreamEndpoint,
  secondaryLaserstreamApiKey: config.secondaryLaserstreamApiKey,
  solanaWssUrl: config.solanaWssUrl,

  paperApiKey: config.paperApiKey,
  jupiterApiKey: config.jupiterApiKey,

  rpcUrl: config.primaryRpcUrl,
  laserstreamApiKey: config.primaryLaserstreamApiKey,
  laserstreamEndpoint: config.primaryLaserstreamEndpoint,
  minTradeAlertValueUsd: 10,
  webhookUrl: '',
};

const INITIAL_COPY_TRADE_SETTINGS: CopyTradeSettings = {
  enabled: false,
  fixedSolAmountPerTrade: 0.5,
  simulatedSlippageBps: 50,
  startingVirtualSolBalance: 10.0,
  takeProfitPercent: 30,
  stopLossPercent: 15,

  confidenceSizingEnabled: false,
  minSizeMultiplier: 0.4,
  maxSizeMultiplier: 1.75,

  trailingStopEnabled: false,
  trailingActivationPercent: 15,
  trailingStopPercent: 12,
};

const INITIAL_BUY_ENTRY_SETTINGS: BuyEntrySettings = {
  enabled: false,
  minMomentumScoreToBuy: 75,
  maxAcceptableRiskLevel: 'MEDIUM',
  requireDevHoldingCheck: false,
  watchWindowMinutes: 15,
};

const INITIAL_PAPER_ACCOUNT: PaperAccount = {
  virtualSolBalance: INITIAL_COPY_TRADE_SETTINGS.startingVirtualSolBalance,
  startingVirtualSolBalance: INITIAL_COPY_TRADE_SETTINGS.startingVirtualSolBalance,
  investedValueSol: 0,
  totalRealizedPnlSol: 0,
  totalUnrealizedPnlSol: 0,
  totalPaperEquitySol: INITIAL_COPY_TRADE_SETTINGS.startingVirtualSolBalance,
};

class Database {
  private data: DbSchema;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.data = this.loadData();
  }

  private loadData(): DbSchema {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          wallets: parsed.wallets || INITIAL_WALLETS,
          trades: parsed.trades || [],
          positions: parsed.positions || [],
          alerts: parsed.alerts || [],
          settings: { ...INITIAL_SETTINGS, ...(parsed.settings || {}) },
          metrics: { ...INITIAL_METRICS, ...(parsed.metrics || {}) },
          copyTradeSettings: { ...INITIAL_COPY_TRADE_SETTINGS, ...(parsed.copyTradeSettings || {}) },
          buyEntrySettings: { ...INITIAL_BUY_ENTRY_SETTINGS, ...(parsed.buyEntrySettings || {}) },
          paperAccount: { ...INITIAL_PAPER_ACCOUNT, ...(parsed.paperAccount || {}) },
          paperPositions: parsed.paperPositions || [],
          paperTrades: parsed.paperTrades || [],
        };
      }
    } catch (err) {
      console.error('Failed to read store.json, re-initializing:', err);
    }

    const initialData: DbSchema = {
      wallets: INITIAL_WALLETS,
      trades: [],
      positions: [],
      alerts: [],
      settings: INITIAL_SETTINGS,
      metrics: INITIAL_METRICS,
      copyTradeSettings: INITIAL_COPY_TRADE_SETTINGS,
      buyEntrySettings: INITIAL_BUY_ENTRY_SETTINGS,
      paperAccount: INITIAL_PAPER_ACCOUNT,
      paperPositions: [],
      paperTrades: [],
    };
    this.saveDataImmediate(initialData);
    return initialData;
  }

  // Synchronous — only used for the one-time initial write at startup
  // (before the server is accepting connections), where blocking briefly
  // is harmless and simpler than plumbing async through the constructor.
  private saveDataImmediate(dataToSave?: DbSchema): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(
        DB_FILE,
        JSON.stringify(dataToSave || this.data, null, 2),
        'utf-8'
      );
    } catch (err) {
      console.error('Failed to write store.json:', err);
    }
  }

  private isWriting = false;
  private writePending = false;

  // Every mutation used to debounce into a *synchronous* fs.writeFileSync of
  // the entire store — blocking the Node event loop (and therefore every
  // in-flight RPC call, WebSocket broadcast, and stream-ingestion step) for
  // however long that disk write took, which got worse over time as the
  // (previously uncapped) positions array grew. Writes are now async and
  // self-serializing: if a write is already in flight when another mutation
  // arrives, it's marked pending and a fresh write (capturing the latest
  // state) runs immediately after the current one finishes, instead of
  // piling up concurrent writes to the same file.
  private async saveDataAsync(): Promise<void> {
    if (this.isWriting) {
      this.writePending = true;
      return;
    }
    this.isWriting = true;
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const snapshot = JSON.stringify(this.data, null, 2);
      await fs.promises.writeFile(DB_FILE, snapshot, 'utf-8');
    } catch (err) {
      console.error('Failed to write store.json:', err);
    } finally {
      this.isWriting = false;
      if (this.writePending) {
        this.writePending = false;
        this.saveDataAsync();
      }
    }
  }

  private saveData(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveDataAsync();
    }, 200);
  }

  // Keeps CLOSED positions bounded (oldest dropped first) while never
  // touching OPEN ones, regardless of where they fall in the array.
  private trimClosedPositions(): void {
    const closedCount = this.data.positions.reduce((n, p) => (p.status === 'CLOSED' ? n + 1 : n), 0);
    if (closedCount <= MAX_CLOSED_POSITIONS) return;
    let toDrop = closedCount - MAX_CLOSED_POSITIONS;
    // Positions are stored newest-first (unshift on insert), so walk from
    // the end to drop the oldest CLOSED ones first.
    for (let i = this.data.positions.length - 1; i >= 0 && toDrop > 0; i--) {
      if (this.data.positions[i].status === 'CLOSED') {
        this.data.positions.splice(i, 1);
        toDrop--;
      }
    }
  }

  private trimClosedPaperPositions(): void {
    const closedCount = this.data.paperPositions.reduce((n, p) => (p.status === 'CLOSED' ? n + 1 : n), 0);
    if (closedCount <= MAX_CLOSED_PAPER_POSITIONS) return;
    let toDrop = closedCount - MAX_CLOSED_PAPER_POSITIONS;
    for (let i = this.data.paperPositions.length - 1; i >= 0 && toDrop > 0; i--) {
      if (this.data.paperPositions[i].status === 'CLOSED') {
        this.data.paperPositions.splice(i, 1);
        toDrop--;
      }
    }
  }

  // --- Wallets ---
  getWallets(): TraderWallet[] {
    return this.data.wallets;
  }

  getWalletByAddress(address: string): TraderWallet | undefined {
    return this.data.wallets.find(
      (w) => w.address.toLowerCase() === address.toLowerCase()
    );
  }

  addWallet(wallet: TraderWallet): TraderWallet {
    this.data.wallets.push(wallet);
    this.data.metrics.activeWalletsCount = this.data.wallets.filter(
      (w) => w.enabled
    ).length;
    this.saveData();
    syncWalletToFirestoreServer(wallet).catch(() => {});
    return wallet;
  }

  updateWallet(address: string, updates: Partial<TraderWallet>): TraderWallet | undefined {
    const idx = this.data.wallets.findIndex(
      (w) => w.address.toLowerCase() === address.toLowerCase()
    );
    if (idx === -1) return undefined;

    this.data.wallets[idx] = {
      ...this.data.wallets[idx],
      ...updates,
      metrics: {
        ...this.data.wallets[idx].metrics,
        ...(updates.metrics || {}),
      },
    };
    this.data.metrics.activeWalletsCount = this.data.wallets.filter(
      (w) => w.enabled
    ).length;
    this.saveData();
    syncWalletToFirestoreServer(this.data.wallets[idx]).catch(() => {});
    return this.data.wallets[idx];
  }

  deleteWallet(address: string): boolean {
    const prevLen = this.data.wallets.length;
    this.data.wallets = this.data.wallets.filter(
      (w) => w.address.toLowerCase() !== address.toLowerCase()
    );
    this.data.metrics.activeWalletsCount = this.data.wallets.filter(
      (w) => w.enabled
    ).length;
    if (this.data.wallets.length !== prevLen) {
      this.saveData();
      deleteWalletFromFirestoreServer(address).catch(() => {});
      return true;
    }
    return false;
  }

  // --- Trades ---
  getTrades(limit = 200, walletAddress?: string): CanonicalTradeEvent[] {
    let list = this.data.trades;
    if (walletAddress) {
      list = list.filter(
        (t) => t.walletAddress.toLowerCase() === walletAddress.toLowerCase()
      );
    }
    return list.slice(0, limit);
  }

  addTrade(trade: CanonicalTradeEvent): void {
    // Keep max 1000 trades in file memory
    this.data.trades.unshift(trade);
    if (this.data.trades.length > 1000) {
      this.data.trades = this.data.trades.slice(0, 1000);
    }
    this.saveData();
  }

  // Backfills a freshly-resolved risk read onto every already-stored trade
  // for the same mint, so REST snapshots (and reconnecting clients) reflect
  // it too, not just whatever was in memory on the live socket.
  updateTradesRiskByMint(tokenMint: string, riskAnalysis: CanonicalTradeEvent['riskAnalysis']): void {
    let changed = false;
    for (const t of this.data.trades) {
      if (t.tokenMint === tokenMint) {
        t.riskAnalysis = riskAnalysis;
        changed = true;
      }
    }
    if (changed) this.saveData();
  }

  // --- Positions ---
  getPositions(walletAddress?: string): Position[] {
    if (walletAddress) {
      return this.data.positions.filter(
        (p) => p.walletAddress.toLowerCase() === walletAddress.toLowerCase()
      );
    }
    return this.data.positions;
  }

  getPosition(walletAddress: string, tokenMint: string): Position | undefined {
    return this.data.positions.find(
      (p) =>
        p.walletAddress.toLowerCase() === walletAddress.toLowerCase() &&
        p.tokenMint === tokenMint &&
        p.status === 'OPEN'
    );
  }

  savePosition(position: Position): void {
    const idx = this.data.positions.findIndex((p) => p.id === position.id);
    if (idx >= 0) {
      this.data.positions[idx] = position;
    } else {
      this.data.positions.unshift(position);
    }
    this.trimClosedPositions();
    this.saveData();
  }

  // --- Alerts ---
  getAlerts(limit = 100): SystemAlert[] {
    return this.data.alerts.slice(0, limit);
  }

  addAlert(alert: SystemAlert): void {
    this.data.alerts.unshift(alert);
    if (this.data.alerts.length > 200) {
      this.data.alerts = this.data.alerts.slice(0, 200);
    }
    this.saveData();
  }

  markAlertsRead(): void {
    this.data.alerts.forEach((a) => (a.read = true));
    this.saveData();
  }

  // --- Settings & Metrics ---
  getSettings(): AppSettings {
    return this.data.settings;
  }

  updateSettings(newSettings: Partial<AppSettings>): AppSettings {
    this.data.settings = { ...this.data.settings, ...newSettings };
    this.saveData();
    syncSettingsToFirestoreServer(this.data.settings).catch(() => {});
    return this.data.settings;
  }

  getMetrics(): SystemMetrics {
    return this.data.metrics;
  }

  updateMetrics(updates: Partial<SystemMetrics>): SystemMetrics {
    this.data.metrics = { ...this.data.metrics, ...updates };
    this.saveData();
    return this.data.metrics;
  }

  clearAllData(): void {
    this.data.trades = [];
    this.data.positions = [];
    this.data.alerts = [];
    this.data.wallets = INITIAL_WALLETS;
    this.data.metrics = INITIAL_METRICS;
    this.saveData();
  }

  // --- Copy Trading Settings ---
  getCopyTradeSettings(): CopyTradeSettings {
    return this.data.copyTradeSettings;
  }

  updateCopyTradeSettings(updates: Partial<CopyTradeSettings>): CopyTradeSettings {
    this.data.copyTradeSettings = { ...this.data.copyTradeSettings, ...updates };
    this.saveData();
    syncCopyTradeSettingsToFirestoreServer(this.data.copyTradeSettings).catch(() => {});
    return this.data.copyTradeSettings;
  }

  // --- Buy Entry Settings ---
  getBuyEntrySettings(): BuyEntrySettings {
    return this.data.buyEntrySettings;
  }

  updateBuyEntrySettings(updates: Partial<BuyEntrySettings>): BuyEntrySettings {
    this.data.buyEntrySettings = { ...this.data.buyEntrySettings, ...updates };
    this.saveData();
    return this.data.buyEntrySettings;
  }

  // --- Paper Trading Account ---
  getPaperTradingMetrics() {
    const closedPositions = this.data.paperPositions.filter((p) => p.status === 'CLOSED');
    const totalPositions = this.data.paperPositions.length;
    const wins = closedPositions.filter((p) => (p.realizedPnlSol || 0) > 0);
    const winRate = closedPositions.length > 0 ? (wins.length / closedPositions.length) * 100 : 0;
    
    let totalPnl = 0;
    let largestWin = 0;
    let largestLoss = 0;
    let totalHoldTimeMs = 0;

    for (const pos of closedPositions) {
      const pnl = pos.realizedPnlSol || 0;
      totalPnl += pnl;
      if (pnl > largestWin) largestWin = pnl;
      if (pnl < largestLoss) largestLoss = pnl;
      if (pos.exitTimestamp && pos.entryTimestamp) {
        totalHoldTimeMs += Math.max(0, pos.exitTimestamp - pos.entryTimestamp);
      }
    }

    const avgPnlPerTrade = closedPositions.length > 0 ? totalPnl / closedPositions.length : 0;
    const avgHoldTimeSec = closedPositions.length > 0 ? Math.round(totalHoldTimeMs / closedPositions.length / 1000) : 0;

    return {
      totalPaperTrades: this.data.paperTrades.length,
      totalPaperPositions: totalPositions,
      closedPositionsCount: closedPositions.length,
      winRate: Math.round(winRate * 10) / 10,
      avgPnlPerTradeSol: Math.round(avgPnlPerTrade * 100000) / 100000,
      largestWinSol: Math.round(largestWin * 100000) / 100000,
      largestLossSol: Math.round(largestLoss * 100000) / 100000,
      avgHoldTimeSec,
      totalPaperEquitySol: this.data.paperAccount.totalPaperEquitySol || this.data.paperAccount.virtualSolBalance || 0,
    };
  }

  getPaperAccount(): PaperAccount {
    return this.data.paperAccount;
  }

  updatePaperAccount(updates: Partial<PaperAccount>): PaperAccount {
    this.data.paperAccount = { ...this.data.paperAccount, ...updates };
    this.saveData();
    syncPaperAccountToFirestoreServer(this.data.paperAccount).catch(() => {});
    return this.data.paperAccount;
  }

  // --- Paper Positions ---
  getPaperPositions(walletAddress?: string): PaperPosition[] {
    if (walletAddress) {
      return this.data.paperPositions.filter(
        (p) => p.sourceWalletAddress.toLowerCase() === walletAddress.toLowerCase()
      );
    }
    return this.data.paperPositions;
  }

  getPaperPosition(walletAddress: string, tokenMint: string): PaperPosition | undefined {
    return this.data.paperPositions.find(
      (p) =>
        p.sourceWalletAddress.toLowerCase() === walletAddress.toLowerCase() &&
        p.tokenMint === tokenMint &&
        p.status !== 'CLOSED' // FIXED: Catches OPEN, EXIT_PENDING, and PAPER_SELLING to prevent concurrent position openings
    );
  }

  savePaperPosition(position: PaperPosition): void {
    const idx = this.data.paperPositions.findIndex((p) => p.id === position.id);
    if (idx >= 0) {
      this.data.paperPositions[idx] = position;
    } else {
      this.data.paperPositions.unshift(position);
    }
    this.trimClosedPaperPositions();
    this.saveData();
    syncPaperPositionToFirestoreServer(position).catch(() => {});
  }

  // --- Paper Trades ---
  getPaperTrades(limit = 200): PaperTrade[] {
    return this.data.paperTrades.slice(0, limit);
  }

  addPaperTrade(trade: PaperTrade): void {
    this.data.paperTrades.unshift(trade);
    if (this.data.paperTrades.length > 1000) {
      this.data.paperTrades = this.data.paperTrades.slice(0, 1000);
    }
    this.saveData();
    syncPaperTradeToFirestoreServer(trade).catch(() => {});
  }

  resetPaperTrading(startingBalance?: number): void {
    if (typeof startingBalance === 'number' && startingBalance > 0) {
      this.data.copyTradeSettings.startingVirtualSolBalance = startingBalance;
    }
    const balance = this.data.copyTradeSettings.startingVirtualSolBalance || 10;
    this.data.paperAccount = {
      virtualSolBalance: balance,
      startingVirtualSolBalance: balance,
      investedValueSol: 0,
      totalRealizedPnlSol: 0,
      totalUnrealizedPnlSol: 0,
      totalPaperEquitySol: balance,
    };
    this.data.paperPositions = [];
    this.data.paperTrades = [];
    this.saveData();
    syncPaperAccountToFirestoreServer(this.data.paperAccount).catch(() => {});
    logUserEntryServer(
      'RESET_PAPER_ACCOUNT',
      `Paper trading reset with ${balance} SOL starting capital`,
      { balance }
    ).catch(() => {});
  }

  // --- Discovery Wallets ---
  getDiscoveredWallets(): DiscoveredWallet[] {
    return this.data.discoveredWallets || [];
  }

  setDiscoveredWallets(wallets: DiscoveredWallet[]): void {
    this.data.discoveredWallets = wallets;
    this.saveData();
  }

  async initFirestoreSync(): Promise<void> {
    try {
      const initial = await loadInitialDataFromFirestoreServer();
      if (initial?.wallets && initial.wallets.length > 0 && this.data.wallets.length === 0) {
        this.data.wallets = initial.wallets;
        this.data.metrics.activeWalletsCount = this.data.wallets.filter((w) => w.enabled).length;
        this.saveData();
        console.log(`[Firebase Server] Hydrated ${initial.wallets.length} wallets from Firestore.`);
      }
    } catch (err) {
      console.error('[Firebase Server] Error during initial Firestore hydration:', err);
    }
  }
}

export const db = new Database();
