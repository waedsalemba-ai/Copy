import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  collection,
  disableNetwork,
  terminate,
  setLogLevel,
  Firestore,
} from 'firebase/firestore';
import fs from 'fs';
import path from 'path';

// Silence internal Firestore log messages completely on server
try {
  setLogLevel('silent');
} catch {}
import {
  TraderWallet,
  AppSettings,
  CopyTradeSettings,
  PaperAccount,
  PaperTrade,
  PaperPosition,
} from '../types';

export const firebaseConfig = {
  projectId: 'powerful-utility-tsx2c',
  appId: '1:787519818654:web:f09635caee4363ce66e48f',
  apiKey: 'AIzaSyBdRlxbgUHegBHbjMWUnYfa2K9FqB0z3sg',
  authDomain: 'powerful-utility-tsx2c.firebaseapp.com',
  firestoreDatabaseId: 'ai-studio-solanatraderwall-7b2f9445-7969-4694-968f-2cebc682fb99',
  storageBucket: 'powerful-utility-tsx2c.firebasestorage.app',
  messagingSenderId: '787519818654',
};

const QUOTA_FILE = path.join(process.cwd(), 'data', 'quota_exceeded.json');

let firestoreInstance: Firestore | null = null;
let firebaseInitialized = false;
let isQuotaExceededServer = false;

// Check server quota state on module load
try {
  if (fs.existsSync(QUOTA_FILE)) {
    const raw = fs.readFileSync(QUOTA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.ts && Date.now() - parsed.ts < 18 * 60 * 60 * 1000) {
      isQuotaExceededServer = true;
      setLogLevel('silent');
      console.warn('[Firebase Server] Persistent quota limit active. Auto-sync disabled; using local store.json.');
    } else {
      fs.unlinkSync(QUOTA_FILE);
    }
  }
} catch {
  // Ignore filesystem exceptions
}

function markServerQuotaExceeded(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes('resource-exhausted') ||
    msg.includes('Quota limit exceeded') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('Code: 8')
  ) {
    if (!isQuotaExceededServer) {
      isQuotaExceededServer = true;
      try {
        const dataDir = path.join(process.cwd(), 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(QUOTA_FILE, JSON.stringify({ ts: Date.now() }), 'utf-8');
      } catch {}
      if (firestoreInstance) {
        terminate(firestoreInstance).catch(() => disableNetwork(firestoreInstance)).catch(() => {});
        firestoreInstance = null;
      }
      console.warn(
        '[Firebase Server] Firestore daily write quota limit reached (20,000 writes/day). Disabled gRPC network streams. Auto-sync operating seamlessly on local store.json.'
      );
    }
    return true;
  }
  return false;
}

export function isFirestoreServerQuotaExceeded(): boolean {
  return isQuotaExceededServer;
}

export function getFirestoreServer(): Firestore | null {
  if (isQuotaExceededServer) return null;
  if (firestoreInstance) return firestoreInstance;
  try {
    const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
    firestoreInstance = getFirestore(
      app,
      firebaseConfig.firestoreDatabaseId || '(default)'
    );
    firebaseInitialized = true;
    console.log('[Firebase Server] Connected to Firestore project:', firebaseConfig.projectId);
    return firestoreInstance;
  } catch (err) {
    console.error('[Firebase Server] Failed to initialize Firestore server instance:', err);
    return null;
  }
}

// Server-side audit log for all user entries
export async function logUserEntryServer(
  type: string,
  title: string,
  details: Record<string, any> | string = {}
) {
  if (isQuotaExceededServer) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const entryId = `entry_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const entryRef = doc(db, 'userEntries', entryId);
    await setDoc(entryRef, {
      id: entryId,
      type,
      title,
      details: typeof details === 'string' ? details : JSON.stringify(details),
      timestamp: Date.now(),
      source: 'server',
    });
  } catch (err) {
    if (markServerQuotaExceeded(err)) return;
    console.error('[Firebase Server] Failed to log user entry:', err);
  }
}

export async function syncWalletToFirestoreServer(wallet: TraderWallet) {
  if (isQuotaExceededServer) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'wallets', wallet.address);
    await setDoc(ref, { ...wallet, updatedAt: Date.now() }, { merge: true });
    await logUserEntryServer(
      'SAVE_WALLET',
      `Saved wallet ${wallet.traderName || 'Trader'} (${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)})`,
      wallet
    );
  } catch (err) {
    if (markServerQuotaExceeded(err)) return;
    console.error('[Firebase Server] Error syncing wallet to Firestore:', err);
  }
}

export async function deleteWalletFromFirestoreServer(address: string) {
  if (isQuotaExceededServer) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'wallets', address);
    await deleteDoc(ref);
    await logUserEntryServer('DELETE_WALLET', `Deleted wallet ${address}`, { address });
  } catch (err) {
    if (markServerQuotaExceeded(err)) return;
    console.error('[Firebase Server] Error deleting wallet from Firestore:', err);
  }
}

export async function syncSettingsToFirestoreServer(settings: AppSettings) {
  if (isQuotaExceededServer) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'settings', 'global');
    await setDoc(ref, { ...settings, updatedAt: Date.now() }, { merge: true });
    await logUserEntryServer('UPDATE_SETTINGS', 'Updated app settings in Firestore', settings);
  } catch (err) {
    if (markServerQuotaExceeded(err)) return;
    console.error('[Firebase Server] Error syncing settings to Firestore:', err);
  }
}

export async function syncCopyTradeSettingsToFirestoreServer(settings: CopyTradeSettings) {
  if (isQuotaExceededServer) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'copyTradeSettings', 'global');
    await setDoc(ref, { ...settings, updatedAt: Date.now() }, { merge: true });
    await logUserEntryServer(
      'UPDATE_COPY_SETTINGS',
      `Copy trading settings updated (${settings.enabled ? 'Enabled' : 'Paused'})`,
      settings
    );
  } catch (err) {
    if (markServerQuotaExceeded(err)) return;
    console.error('[Firebase Server] Error syncing copy trade settings:', err);
  }
}

export async function syncPaperAccountToFirestoreServer(account: PaperAccount) {
  if (isQuotaExceededServer) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'paperAccount', 'global');
    await setDoc(ref, { ...account, updatedAt: Date.now() }, { merge: true });
  } catch (err) {
    if (markServerQuotaExceeded(err)) return;
    console.error('[Firebase Server] Error syncing paper account:', err);
  }
}

export async function syncPaperTradeToFirestoreServer(trade: PaperTrade) {
  if (isQuotaExceededServer) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'paperTrades', trade.id);
    await setDoc(ref, trade);
    await logUserEntryServer(
      'PAPER_TRADE_EXECUTED',
      `Simulated ${trade.action} for ${trade.tokenSymbol}`,
      trade
    );
  } catch (err) {
    if (markServerQuotaExceeded(err)) return;
    console.error('[Firebase Server] Error syncing paper trade:', err);
  }
}

export async function syncPaperPositionToFirestoreServer(position: PaperPosition) {
  if (isQuotaExceededServer) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'paperPositions', position.id);
    await setDoc(ref, { ...position, updatedAt: Date.now() });
  } catch (err) {
    if (markServerQuotaExceeded(err)) return;
    console.error('[Firebase Server] Error syncing paper position:', err);
  }
}

// Hydrate existing wallets and settings from Firestore on server startup
export async function loadInitialDataFromFirestoreServer(): Promise<{
  wallets?: TraderWallet[];
  settings?: AppSettings;
  copyTradeSettings?: CopyTradeSettings;
  paperAccount?: PaperAccount;
} | null> {
  if (isQuotaExceededServer) return null;
  try {
    const db = getFirestoreServer();
    if (!db) return null;
    const walletsSnap = await getDocs(collection(db, 'wallets'));
    const wallets: TraderWallet[] = [];
    walletsSnap.forEach((d) => {
      wallets.push(d.data() as TraderWallet);
    });
    return { wallets: wallets.length ? wallets : undefined };
  } catch (err) {
    if (markServerQuotaExceeded(err)) return null;
    console.warn('[Firebase Server] Could not fetch initial data from Firestore:', err);
    return null;
  }
}
