import { initializeApp, getApps, getApp } from 'firebase/app';
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

export const firestore = null;
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

// Validate Connection to Firestore via Express Server API endpoint
export const testFirestoreConnection = async (): Promise<boolean> => {
  try {
    const res = await fetch('/api/firebase/status');
    if (res.ok) {
      connectionVerified = true;
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

// --- Firestore User Entry Persistence Functions ---
// All persistent database operations are handled directly by the Express backend server
// (/api/wallets, /api/settings, etc.) via db.ts and firebaseServer.ts.

export const logUserEntryToFirestore = async (
  _type: string,
  _title: string,
  _details: Record<string, any> | string = {}
) => {
  // Handled server-side
};

export const saveWalletToFirestore = async (_wallet: TraderWallet) => {
  // Handled server-side via POST/PUT /api/wallets
};

export const deleteWalletFromFirestore = async (_address: string) => {
  // Handled server-side via DELETE /api/wallets
};

export const saveSettingsToFirestore = async (_settings: AppSettings) => {
  // Handled server-side via POST /api/settings
};

export const saveCopyTradeSettingsToFirestore = async (_settings: CopyTradeSettings) => {
  // Handled server-side via POST /api/copy-trade/settings
};

export const savePaperAccountToFirestore = async (_account: PaperAccount) => {
  // Handled server-side
};

export const savePaperTradeToFirestore = async (_trade: PaperTrade) => {
  // Handled server-side via /api/paper/trade
};

export const savePaperPositionToFirestore = async (_position: PaperPosition) => {
  // Handled server-side
};
