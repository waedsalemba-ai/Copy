import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  deleteDoc,
  getDocFromServer,
  collection,
  onSnapshot,
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

let currentUser: User | null = null;
let connectionVerified = false;

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
  try {
    await getDocFromServer(doc(firestore, 'test', 'connection'));
    connectionVerified = true;
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
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
    console.error('[Firebase] Failed to log user entry:', err);
  }
};

export const saveWalletToFirestore = async (wallet: TraderWallet) => {
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
    console.error('[Firebase] Failed to save wallet to Firestore:', err);
  }
};

export const deleteWalletFromFirestore = async (address: string) => {
  try {
    const walletRef = doc(firestore, 'wallets', address);
    await deleteDoc(walletRef);
    await logUserEntryToFirestore('DELETE_WALLET', `Deleted wallet ${address.slice(0, 4)}...${address.slice(-4)}`, { address });
  } catch (err) {
    console.error('[Firebase] Failed to delete wallet from Firestore:', err);
  }
};

export const saveSettingsToFirestore = async (settings: AppSettings) => {
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
    console.error('[Firebase] Failed to save settings to Firestore:', err);
  }
};

export const saveCopyTradeSettingsToFirestore = async (settings: CopyTradeSettings) => {
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
    console.error('[Firebase] Failed to save copy trade settings to Firestore:', err);
  }
};

export const savePaperAccountToFirestore = async (account: PaperAccount) => {
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
    console.error('[Firebase] Failed to save paper account to Firestore:', err);
  }
};

export const savePaperTradeToFirestore = async (trade: PaperTrade) => {
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
    console.error('[Firebase] Failed to save paper trade to Firestore:', err);
  }
};

export const savePaperPositionToFirestore = async (position: PaperPosition) => {
  try {
    const posRef = doc(firestore, 'paperPositions', position.id);
    await setDoc(posRef, {
      ...position,
      userId: currentUser?.uid || 'anonymous',
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error('[Firebase] Failed to save paper position to Firestore:', err);
  }
};
