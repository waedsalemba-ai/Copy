import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  deleteDoc,
  getDocFromServer,
  collection,
  onSnapshot,
  disableNetwork,
  Firestore,
} from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged, User } from 'firebase/auth';
import { TraderWallet, AppSettings, CopyTradeSettings, PaperAccount, PaperTrade, PaperPosition } from './types';

export const firebaseConfig = {
  projectId: 'powerful-utility-tsx2c',
  appId: '1:787519818654:web:f09635caee4363ce66e48f',
  apiKey: 'AIzaSyBdRlxbgUHegBHbjMWUnYfa2K9FqB0z3sg',
  authDomain: 'powerful-utility-tsx2c.firebaseapp.com',
  firestoreDatabaseId: 'ai-studio-solanatraderwall-7b2f9445-7969-4694-968f-2cebc682fb99',
  storageBucket: 'powerful-utility-tsx2c.firebasestorage.app',
  messagingSenderId: '787519818654',
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

export const firestore: Firestore = getFirestore(
  app,
  firebaseConfig.firestoreDatabaseId || '(default)'
);

export const auth = getAuth(app);

const QUOTA_STORAGE_KEY = 'solana_trader_firestore_quota_exceeded';

let currentUser: User | null = null;
let connectionVerified = false;
let isQuotaExceededClient = false;
let quotaListeners: Array<(exceeded: boolean) => void> = [];

// Proactively disable network at startup if quota was previously exceeded
try {
  const savedQuotaTs = typeof window !== 'undefined' ? localStorage.getItem(QUOTA_STORAGE_KEY) : null;
  if (savedQuotaTs) {
    const elapsedMs = Date.now() - Number(savedQuotaTs);
    if (elapsedMs < 18 * 60 * 60 * 1000) {
      isQuotaExceededClient = true;
      disableNetwork(firestore).catch(() => {});
      console.warn('[Firebase Client] Persistent quota limit active. Firestore network stream disabled; using local storage.');
    } else {
      localStorage.removeItem(QUOTA_STORAGE_KEY);
    }
  }
} catch {
  // Ignore localStorage exceptions
}

export const setClientQuotaExceeded = (exceeded: boolean) => {
  if (exceeded && !isQuotaExceededClient) {
    isQuotaExceededClient = true;
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem(QUOTA_STORAGE_KEY, String(Date.now()));
      }
    } catch {}
    disableNetwork(firestore).catch(() => {});
    quotaListeners.forEach((cb) => cb(true));
  }
};

export const isFirestoreQuotaExceeded = (): boolean => isQuotaExceededClient;

export const subscribeQuotaStatus = (cb: (exceeded: boolean) => void) => {
  quotaListeners.push(cb);
  cb(isQuotaExceededClient);
  return () => {
    quotaListeners = quotaListeners.filter((l) => l !== cb);
  };
};

function markQuotaExceeded(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes('resource-exhausted') ||
    msg.includes('Quota limit exceeded') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('Code: 8')
  ) {
    if (!isQuotaExceededClient) {
      isQuotaExceededClient = true;
      try {
        if (typeof window !== 'undefined') {
          localStorage.setItem(QUOTA_STORAGE_KEY, String(Date.now()));
        }
      } catch {}
      console.warn(
        '[Firebase Client] Firestore daily write quota limit reached (20,000 writes/day). Disabling Firestore network stream. Operating in Local Storage mode.'
      );
      disableNetwork(firestore).catch(() => {});
      quotaListeners.forEach((cb) => cb(true));
    }
    return true;
  }
  return false;
}

// Initialize Anonymous Authentication for User Identity
export const initFirebaseAuth = async (): Promise<User | null> => {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUser = user;
        resolve(user);
      } else {
        try {
          const cred = await signInAnonymously(auth);
          currentUser = cred.user;
          resolve(cred.user);
        } catch (err) {
          console.warn('[Firebase Auth] Anonymous sign-in fallback:', err);
          resolve(null);
        }
      }
    });
  });
};

// Validate Connection to Firestore (Per SKILL.md specification)
export const testFirestoreConnection = async (): Promise<boolean> => {
  if (isQuotaExceededClient) return false;
  try {
    await getDocFromServer(doc(firestore, 'test', 'connection'));
    connectionVerified = true;
    return true;
  } catch (error) {
    if (markQuotaExceeded(error)) {
      return false;
    }
    if (
      error instanceof Error &&
      (error.message.includes('the client is offline') ||
        error.message.includes('unavailable') ||
        error.message.includes('Could not reach Cloud Firestore backend'))
    ) {
      console.warn('[Firebase] Client operating in local/offline mode.');
      return false;
    }
    // Any other response (like doc not found) confirms live server connectivity
    connectionVerified = true;
    return true;
  }
};

// --- Firestore User Entry Persistence Functions ---

export const logUserEntryToFirestore = async (
  type: string,
  title: string,
  details: Record<string, any> | string = {}
) => {
  if (isQuotaExceededClient) return;
  try {
    const entryId = `entry_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const entryRef = doc(firestore, 'userEntries', entryId);
    await setDoc(entryRef, {
      id: entryId,
      type,
      title,
      details: typeof details === 'string' ? details : JSON.stringify(details),
      timestamp: Date.now(),
      userId: currentUser?.uid || 'anonymous',
    });
  } catch (err) {
    if (markQuotaExceeded(err)) return;
    console.error('[Firebase] Failed to log user entry:', err);
  }
};

export const saveWalletToFirestore = async (wallet: TraderWallet) => {
  if (isQuotaExceededClient) return;
  try {
    const walletRef = doc(firestore, 'wallets', wallet.address);
    await setDoc(
      walletRef,
      {
        ...wallet,
        userId: currentUser?.uid || 'anonymous',
        updatedAt: Date.now(),
      },
      { merge: true }
    );
    await logUserEntryToFirestore(
      'SAVE_WALLET',
      `Saved wallet ${wallet.traderName || 'Trader'} (${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)})`,
      {
        address: wallet.address,
        traderName: wallet.traderName,
        enabled: wallet.enabled,
      }
    );
  } catch (err) {
    if (markQuotaExceeded(err)) return;
    console.error('[Firebase] Failed to save wallet to Firestore:', err);
  }
};

export const deleteWalletFromFirestore = async (address: string) => {
  if (isQuotaExceededClient) return;
  try {
    const walletRef = doc(firestore, 'wallets', address);
    await deleteDoc(walletRef);
    await logUserEntryToFirestore('DELETE_WALLET', `Deleted wallet ${address.slice(0, 4)}...${address.slice(-4)}`, { address });
  } catch (err) {
    if (markQuotaExceeded(err)) return;
    console.error('[Firebase] Failed to delete wallet from Firestore:', err);
  }
};

export const saveSettingsToFirestore = async (settings: AppSettings) => {
  if (isQuotaExceededClient) return;
  try {
    const settingsRef = doc(firestore, 'settings', 'global');
    await setDoc(
      settingsRef,
      {
        ...settings,
        userId: currentUser?.uid || 'anonymous',
        updatedAt: Date.now(),
      },
      { merge: true }
    );
    await logUserEntryToFirestore('UPDATE_SETTINGS', 'Updated application node and notification settings', {
      rpcUrl: settings.rpcUrl,
      minTradeAlertValueUsd: settings.minTradeAlertValueUsd,
    });
  } catch (err) {
    if (markQuotaExceeded(err)) return;
    console.error('[Firebase] Failed to save settings to Firestore:', err);
  }
};

export const saveCopyTradeSettingsToFirestore = async (settings: CopyTradeSettings) => {
  if (isQuotaExceededClient) return;
  try {
    const copyRef = doc(firestore, 'copyTradeSettings', 'global');
    await setDoc(
      copyRef,
      {
        ...settings,
        userId: currentUser?.uid || 'anonymous',
        updatedAt: Date.now(),
      },
      { merge: true }
    );
    await logUserEntryToFirestore('UPDATE_COPY_SETTINGS', `Updated copy trade settings (${settings.enabled ? 'Enabled' : 'Paused'})`, {
      enabled: settings.enabled,
      fixedSolAmountPerTrade: settings.fixedSolAmountPerTrade,
      simulatedSlippageBps: settings.simulatedSlippageBps,
    });
  } catch (err) {
    if (markQuotaExceeded(err)) return;
    console.error('[Firebase] Failed to save copy trade settings to Firestore:', err);
  }
};

export const savePaperAccountToFirestore = async (account: PaperAccount) => {
  if (isQuotaExceededClient) return;
  try {
    const accRef = doc(firestore, 'paperAccount', 'global');
    await setDoc(
      accRef,
      {
        ...account,
        userId: currentUser?.uid || 'anonymous',
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  } catch (err) {
    if (markQuotaExceeded(err)) return;
    console.error('[Firebase] Failed to save paper account to Firestore:', err);
  }
};

export const savePaperTradeToFirestore = async (trade: PaperTrade) => {
  if (isQuotaExceededClient) return;
  try {
    const tradeRef = doc(firestore, 'paperTrades', trade.id);
    await setDoc(tradeRef, {
      ...trade,
      userId: currentUser?.uid || 'anonymous',
    });
    await logUserEntryToFirestore(
      'PAPER_TRADE_EXECUTED',
      `Executed ${trade.action} for ${trade.tokenSymbol} (${trade.solAmount.toFixed(3)} SOL)`,
      trade
    );
  } catch (err) {
    if (markQuotaExceeded(err)) return;
    console.error('[Firebase] Failed to save paper trade to Firestore:', err);
  }
};

export const savePaperPositionToFirestore = async (position: PaperPosition) => {
  if (isQuotaExceededClient) return;
  try {
    const posRef = doc(firestore, 'paperPositions', position.id);
    await setDoc(posRef, {
      ...position,
      userId: currentUser?.uid || 'anonymous',
      updatedAt: Date.now(),
    });
  } catch (err) {
    if (markQuotaExceeded(err)) return;
    console.error('[Firebase] Failed to save paper position to Firestore:', err);
  }
};
