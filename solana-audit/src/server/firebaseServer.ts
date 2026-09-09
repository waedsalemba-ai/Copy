import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  collection,
  Firestore,
} from 'firebase/firestore';
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

let firestoreInstance: Firestore | null = null;
let firebaseInitialized = false;

export function getFirestoreServer(): Firestore | null {
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
    console.error('[Firebase Server] Failed to log user entry:', err);
  }
}

export async function syncWalletToFirestoreServer(wallet: TraderWallet) {
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
    console.error('[Firebase Server] Error syncing wallet to Firestore:', err);
  }
}

export async function deleteWalletFromFirestoreServer(address: string) {
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'wallets', address);
    await deleteDoc(ref);
    await logUserEntryServer('DELETE_WALLET', `Deleted wallet ${address}`, { address });
  } catch (err) {
    console.error('[Firebase Server] Error deleting wallet from Firestore:', err);
  }
}

export async function syncSettingsToFirestoreServer(settings: AppSettings) {
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'settings', 'global');
    await setDoc(ref, { ...settings, updatedAt: Date.now() }, { merge: true });
    await logUserEntryServer('UPDATE_SETTINGS', 'Updated app settings in Firestore', settings);
  } catch (err) {
    console.error('[Firebase Server] Error syncing settings to Firestore:', err);
  }
}

export async function syncCopyTradeSettingsToFirestoreServer(settings: CopyTradeSettings) {
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
    console.error('[Firebase Server] Error syncing copy trade settings:', err);
  }
}

export async function syncPaperAccountToFirestoreServer(account: PaperAccount) {
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'paperAccount', 'global');
    await setDoc(ref, { ...account, updatedAt: Date.now() }, { merge: true });
  } catch (err) {
    console.error('[Firebase Server] Error syncing paper account:', err);
  }
}

export async function syncPaperTradeToFirestoreServer(trade: PaperTrade) {
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
    console.error('[Firebase Server] Error syncing paper trade:', err);
  }
}

export async function syncPaperPositionToFirestoreServer(position: PaperPosition) {
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'paperPositions', position.id);
    await setDoc(ref, { ...position, updatedAt: Date.now() });
  } catch (err) {
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
    console.warn('[Firebase Server] Could not fetch initial data from Firestore:', err);
    return null;
  }
}
