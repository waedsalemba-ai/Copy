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

// Suppress internal Firestore gRPC/WebChannel transport retry warnings
setLogLevel('silent');
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
let serverQuotaExceeded = false;

const lastServerPosSync = new Map<string, number>();
let lastServerAccountSync = 0;

function isQuotaError(err: any): boolean {
  if (!err) return false;
  const code = err.code || err.name || '';
  const msg = err.message || String(err);
  return (
    code === 'resource-exhausted' ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('Quota limit exceeded') ||
    msg.includes('Quota exceeded') ||
    msg.includes('code=resource-exhausted')
  );
}

function handleServerFirestoreError(context: string, err: any) {
  if (isQuotaError(err)) {
    if (!serverQuotaExceeded) {
      serverQuotaExceeded = true;
      if (firestoreInstance) {
        disableNetwork(firestoreInstance).catch(() => {});
        terminate(firestoreInstance).catch(() => {});
        firestoreInstance = null;
      }
      console.warn('[Firebase Server] Firestore daily write quota limit reached. Closed gRPC write stream; operating cleanly in local JSON mode.');
    }
  } else {
    console.error(`[Firebase Server] ${context}:`, err);
  }
}

export function getFirestoreServer(): Firestore | null {
  if (serverQuotaExceeded) return null;
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
    handleServerFirestoreError('Failed to initialize Firestore server instance', err);
    return null;
  }
}

// Server-side audit log for key user events
export async function logUserEntryServer(
  type: string,
  title: string,
  details: Record<string, any> | string = {}
) {
  if (serverQuotaExceeded) return;
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
    handleServerFirestoreError('Failed to log user entry', err);
  }
}

export async function syncWalletToFirestoreServer(wallet: TraderWallet) {
  if (serverQuotaExceeded) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'wallets', wallet.address);
    await setDoc(ref, { ...wallet, updatedAt: Date.now() }, { merge: true });
  } catch (err) {
    handleServerFirestoreError('Error syncing wallet to Firestore', err);
  }
}

export async function deleteWalletFromFirestoreServer(address: string) {
  if (serverQuotaExceeded) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'wallets', address);
    await deleteDoc(ref);
  } catch (err) {
    handleServerFirestoreError('Error deleting wallet from Firestore', err);
  }
}

export async function syncSettingsToFirestoreServer(settings: AppSettings) {
  if (serverQuotaExceeded) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'settings', 'global');
    await setDoc(ref, { ...settings, updatedAt: Date.now() }, { merge: true });
  } catch (err) {
    handleServerFirestoreError('Error syncing settings to Firestore', err);
  }
}

export async function syncCopyTradeSettingsToFirestoreServer(settings: CopyTradeSettings) {
  if (serverQuotaExceeded) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'copyTradeSettings', 'global');
    await setDoc(ref, { ...settings, updatedAt: Date.now() }, { merge: true });
  } catch (err) {
    handleServerFirestoreError('Error syncing copy trade settings', err);
  }
}

export async function syncPaperAccountToFirestoreServer(account: PaperAccount) {
  if (serverQuotaExceeded) return;
  const now = Date.now();
  if (now - lastServerAccountSync < 60000) return; // Throttle to once every 60s
  lastServerAccountSync = now;

  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'paperAccount', 'global');
    await setDoc(ref, { ...account, updatedAt: Date.now() }, { merge: true });
  } catch (err) {
    handleServerFirestoreError('Error syncing paper account', err);
  }
}

export async function syncPaperTradeToFirestoreServer(trade: PaperTrade) {
  if (serverQuotaExceeded) return;
  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'paperTrades', trade.id);
    await setDoc(ref, trade);
  } catch (err) {
    handleServerFirestoreError('Error syncing paper trade', err);
  }
}

export async function syncPaperPositionToFirestoreServer(position: PaperPosition) {
  if (serverQuotaExceeded) return;
  const now = Date.now();
  const lastSync = lastServerPosSync.get(position.id) || 0;
  // Throttle open position updates to at most once per 5 minutes
  if (position.status === 'OPEN' && now - lastSync < 300000) return;
  lastServerPosSync.set(position.id, now);

  try {
    const db = getFirestoreServer();
    if (!db) return;
    const ref = doc(db, 'paperPositions', position.id);
    await setDoc(ref, { ...position, updatedAt: Date.now() });
  } catch (err) {
    handleServerFirestoreError('Error syncing paper position', err);
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
