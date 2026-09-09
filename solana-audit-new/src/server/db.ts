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
}

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

const INITIAL_WALLETS: TraderWallet[] = [];

const INITIAL_METRICS: SystemMetrics = {
  laserstreamConnected: false,
  laserstreamEndpoint: config.laserstreamEndpoint,
  rpcConnected: false,
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
  rpcUrl: config.rpcUrl,
  laserstreamApiKey: config.laserstreamApiKey,
  laserstreamEndpoint: config.laserstreamEndpoint,
  minTradeAlertValueUsd: 10,
  webhookUrl: '',
};

const INITIAL_COPY_TRADE_SETTINGS: CopyTradeSettings = {
  enabled: false,
  fixedSolAmountPerTrade: 0.1,
  simulatedSlippageBps: 50,
  startingVirtualSolBalance: 10,
  takeProfitPercent: 30,
  stopLossPercent: 15,
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
  totalRealizedPnlSol: 0,
};

class Database {
  private data: DbSchema;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistInFlight = false;
  private persistQueued = false;

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
          settings: parsed.settings || INITIAL_SETTINGS,
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
    this.saveData(initialData);
    return initialData;
  }

  private saveData(dataToSave?: DbSchema): void {
    this.persistQueued = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushPersistence().catch((err) => console.error('Failed to write store.json:', err));
    }, 50);
  }

  private async flushPersistence(): Promise<void> {
    if (this.persistInFlight || !this.persistQueued) return;
    this.persistQueued = false;
    this.persistInFlight = true;
    try {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      const tmpFile = `${DB_FILE}.tmp`;
      await fs.promises.writeFile(tmpFile, JSON.stringify(this.data), 'utf-8');
      await fs.promises.rename(tmpFile, DB_FILE);
    } finally {
      this.persistInFlight = false;
      if (this.persistQueued && !this.persistTimer) {
        this.persistTimer = setTimeout(() => {
          this.persistTimer = null;
          this.flushPersistence().catch((err) => console.error('Failed to write store.json:', err));
        }, 50);
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
    this.data.wallets = [];
    this.data.metrics = { ...INITIAL_METRICS };
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
        p.status === 'OPEN'
    );
  }

  hasPaperTradeForSourceEvent(sourceEventId: string, action?: PaperTrade['action']): boolean {
    return this.data.paperTrades.some((trade) =>
      trade.sourceEventId === sourceEventId && (!action || trade.action === action)
    );
  }

  savePaperPosition(position: PaperPosition): void {
    const idx = this.data.paperPositions.findIndex((p) => p.id === position.id);
    if (idx >= 0) {
      this.data.paperPositions[idx] = position;
    } else {
      this.data.paperPositions.unshift(position);
    }
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
      totalRealizedPnlSol: 0,
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
