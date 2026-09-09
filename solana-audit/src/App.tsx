import React, { useState, useEffect, useRef } from 'react';
import { Navbar } from './components/Navbar';
import { StatCards } from './components/StatCards';
import { SettingsView } from './components/SettingsView';
const LiveTradesFeed = React.lazy(() => import('./components/LiveTradesFeed').then((m) => ({ default: m.LiveTradesFeed })));
const WalletsView = React.lazy(() => import('./components/WalletsView').then((m) => ({ default: m.WalletsView })));
const PositionsView = React.lazy(() => import('./components/PositionsView').then((m) => ({ default: m.PositionsView })));
const AlertsView = React.lazy(() => import('./components/AlertsView').then((m) => ({ default: m.AlertsView })));
const ObservabilityView = React.lazy(() => import('./components/ObservabilityView').then((m) => ({ default: m.ObservabilityView })));
const PaperTradingPanel = React.lazy(() => import('./components/PaperTradingPanel').then((m) => ({ default: m.PaperTradingPanel })));
import { audioSynth } from './components/AudioSynth';
import {
  initFirebaseAuth,
  testFirestoreConnection,
  saveWalletToFirestore,
  deleteWalletFromFirestore,
  saveSettingsToFirestore,
} from './firebase';

import {
  TraderWallet,
  CanonicalTradeEvent,
  Position,
  SystemAlert,
  SystemMetrics,
  AppSettings,
  AcceptanceTestReport,
} from './types';

const INITIAL_METRICS: SystemMetrics = {
  laserstreamConnected: false,
  laserstreamEndpoint: 'wss://laserstream.solana.com/v1/stream',
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
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  laserstreamApiKey: '',
  laserstreamEndpoint: 'wss://laserstream.solana.com/v1/stream',
  minTradeAlertValueUsd: 10,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [wallets, setWallets] = useState<TraderWallet[]>([]);
  const [trades, setTrades] = useState<CanonicalTradeEvent[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [metrics, setMetrics] = useState<SystemMetrics>(INITIAL_METRICS);
  const [settings, setSettings] = useState<AppSettings>(INITIAL_SETTINGS);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [testReport, setTestReport] = useState<AcceptanceTestReport | null>(null);
  const [firebaseSynced, setFirebaseSynced] = useState<boolean>(true);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);

  // Initial Data Fetch & Firebase Initialization
  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    setupWebSocket();

    // Authenticate and verify Firestore connection
    initFirebaseAuth().catch(() => {});
    testFirestoreConnection()
      .then((ok) => setFirebaseSynced(ok))
      .catch(() => setFirebaseSynced(false));

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const fetchData = async () => {
    try {
      const [wRes, tRes, pRes, aRes, mRes, sRes] = await Promise.all([
        fetch('/api/wallets').then((r) => r.json()),
        fetch('/api/trades').then((r) => r.json()),
        fetch('/api/positions').then((r) => r.json()),
        fetch('/api/alerts').then((r) => r.json()),
        fetch('/api/metrics').then((r) => r.json()),
        fetch('/api/settings').then((r) => r.json()),
      ]);

      if (Array.isArray(wRes)) setWallets(wRes);
      if (Array.isArray(tRes)) {
        const unique = Array.from(new Map(tRes.map((t: CanonicalTradeEvent) => [t.id, t])).values());
        setTrades(unique);
      }
      if (Array.isArray(pRes)) setPositions(pRes);
      if (Array.isArray(aRes)) setAlerts(aRes);
      if (mRes && typeof mRes === 'object') setMetrics(mRes);
      if (sRes && typeof sRes === 'object') setSettings(sRes);
    } catch (err) {
      console.error('Failed to fetch initial data:', err);
    }
  };

  const setupWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const { type, payload } = msg;

        switch (type) {
          case 'SNAPSHOT':
            if (payload.wallets) setWallets(payload.wallets);
            if (payload.trades) {
              const unique = Array.from(new Map(payload.trades.map((t: CanonicalTradeEvent) => [t.id, t])).values());
              setTrades(unique);
            }
            if (payload.positions) setPositions(payload.positions);
            if (payload.alerts) setAlerts(payload.alerts);
            if (payload.metrics) setMetrics(payload.metrics);
            break;

          case 'TRADE_DETECTED':
            setTrades((prev) => {
              if (prev.some((t) => t.id === payload.id)) return prev;
              return [payload, ...prev.slice(0, 999)];
            });

            // Play audio chime
            if (audioEnabled) {
              if (payload.action === 'BUY') audioSynth.playBuyChime();
              else if (payload.action === 'SELL') audioSynth.playSellChime();
            }

            // Show Toast
            const toastTxt = `${payload.action === 'BUY' ? '🟢' : '🔴'} ${payload.traderName} ${
              payload.action
            } ${payload.tokenSymbol} (${payload.solAmount.toFixed(2)} SOL)`;
            setToastMessage(toastTxt);
            setTimeout(() => setToastMessage(null), 3000);

            break;

          case 'POSITION_UPDATED':
            setPositions((prev) => {
              const idx = prev.findIndex((p) => p.id === payload.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = payload;
                return next;
              }
              return [payload, ...prev];
            });
            break;

          case 'SYSTEM_ALERT':
            setAlerts((prev) => [payload, ...prev.slice(0, 199)]);
            break;

          case 'METRICS_UPDATED':
            setMetrics(payload);
            break;

          case 'WALLET_ADDED':
            setWallets((prev) => [...prev, payload]);
            break;

          case 'WALLET_UPDATED':
            setWallets((prev) =>
              prev.map((w) => (w.address.toLowerCase() === payload.address.toLowerCase() ? payload : w))
            );
            break;

          case 'WALLET_DELETED':
            setWallets((prev) =>
              prev.filter((w) => w.address.toLowerCase() !== payload.address.toLowerCase())
            );
            break;

          case 'TOKEN_RISK_UPDATED':
            // A background risk check resolved for this mint — patch every
            // matching row (past and future) rather than waiting on a new trade.
            setTrades((prev) =>
              prev.map((t) => (t.tokenMint === payload.tokenMint ? { ...t, riskAnalysis: payload } : t))
            );
            break;
        }
      } catch (err) {
        console.error('WebSocket parse error:', err);
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current || wsRef.current !== ws) return;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (mountedRef.current) setupWebSocket();
      }, 3000);
    };
  };

  // API Call Handlers
  const handleAddWallet = async (walletData: any) => {
    const res = await fetch('/api/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(walletData),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to add wallet');
    }
    const newWallet = await res.json();
    setWallets((prev) => [...prev, newWallet]);
    saveWalletToFirestore(newWallet).catch(() => {});
  };

  const handleUpdateWallet = async (address: string, updates: Partial<TraderWallet>) => {
    const res = await fetch(`/api/wallets/${address}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      const updated = await res.json();
      setWallets((prev) =>
        prev.map((w) => (w.address.toLowerCase() === address.toLowerCase() ? updated : w))
      );
      saveWalletToFirestore(updated).catch(() => {});
    }
  };

  const handleDeleteWallet = async (address: string) => {
    const res = await fetch(`/api/wallets/${address}`, { method: 'DELETE' });
    if (res.ok) {
      setWallets((prev) => prev.filter((w) => w.address.toLowerCase() !== address.toLowerCase()));
      deleteWalletFromFirestore(address).catch(() => {});
    }
  };

  const handleSaveSettings = async (newSettings: Partial<AppSettings>) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings),
    });
    if (res.ok) {
      const updated = await res.json();
      setSettings(updated);
      saveSettingsToFirestore(updated).catch(() => {});
    }
  };

  const handleTestRpc = async () => {
    const res = await fetch('/api/settings/test-rpc', { method: 'POST' });
    const data = await res.json();
    setToastMessage(`RPC Test: ${data.ok ? 'CONNECTED' : 'FAILED'} (${data.latencyMs}ms)`);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleTestLaserstream = async () => {
    const res = await fetch('/api/settings/test-laserstream', { method: 'POST' });
    const data = await res.json();
    setToastMessage(`LaserStream Test: ${data.ok ? 'CONNECTED' : 'FAILED'}`);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleRunTest = async () => {
    const res = await fetch('/api/dev/run-test', { method: 'POST' });
    const report: AcceptanceTestReport = await res.json();
    setTestReport(report);
    setActiveTab('settings');
    return report;
  };

  const handleClearData = async () => {
    await fetch('/api/dev/clear-data', { method: 'POST' });
    setTrades([]);
    setPositions([]);
    setAlerts([]);
  };

  const handleMarkAlertsRead = async () => {
    await fetch('/api/alerts/mark-read', { method: 'POST' });
    setAlerts((prev) => prev.map((a) => ({ ...a, read: true })));
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-[#fafafa] flex flex-col font-sans selection:bg-[#00FF88] selection:text-[#09090b]">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-16 right-4 z-50 px-3.5 py-2 rounded bg-[#18181b] border border-[#00FF88]/40 text-[#00FF88] font-mono text-xs shadow-2xl flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#00FF88] animate-ping"></span>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Main Navbar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        metrics={metrics}
        onRunTest={handleRunTest}
        audioEnabled={audioEnabled}
        setAudioEnabled={setAudioEnabled}
        firebaseSynced={firebaseSynced}
      />

      <main className="flex-1 max-w-[1600px] w-full mx-auto p-3 space-y-3">
        {/* Top Metric Cards (always visible on main trading terminal) */}
        <StatCards metrics={metrics} positions={positions} />

        <React.Suspense fallback={<div className="p-6 text-xs text-[#71717a] font-mono">Loading view...</div>}>
        {/* Tab Content Rendering */}
        {activeTab === 'dashboard' && (
          <div className="space-y-3">
            <LiveTradesFeed trades={trades} limit={50} />
            <PositionsView positions={positions} />
          </div>
        )}

        {activeTab === 'traders' && (
          <WalletsView
            wallets={wallets}
            positions={positions}
            trades={trades}
            onAddWallet={handleAddWallet}
            onUpdateWallet={handleUpdateWallet}
            onDeleteWallet={handleDeleteWallet}
          />
        )}

        {activeTab === 'trades' && <LiveTradesFeed trades={trades} />}

        {activeTab === 'positions' && <PositionsView positions={positions} />}

        {activeTab === 'paper' && <PaperTradingPanel />}

        {activeTab === 'alerts' && (
          <AlertsView
            alerts={alerts}
            onMarkRead={handleMarkAlertsRead}
            audioEnabled={audioEnabled}
            setAudioEnabled={setAudioEnabled}
          />
        )}

        {activeTab === 'observability' && (
          <ObservabilityView
            metrics={metrics}
            onTestRpc={handleTestRpc}
            onTestLaserstream={handleTestLaserstream}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsView
            settings={settings}
            metrics={metrics}
            onSaveSettings={handleSaveSettings}
            onTestRpc={handleTestRpc}
            onTestLaserstream={handleTestLaserstream}
            onRunTest={handleRunTest}
            onClearData={handleClearData}
            testReport={testReport}
          />
        )}
        </React.Suspense>
      </main>

      <footer className="h-7 border-t border-[#27272a] bg-[#18181b] flex items-center px-4 justify-between text-[10px] text-[#71717a] font-mono">
        <div className="flex gap-4 items-center">
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-[#71717a] uppercase">DB:</span>
            <span className="text-[#00FF88] uppercase font-bold">OPERATIONAL</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-[#71717a] uppercase">PIPELINE:</span>
            <span className="text-[#00FF88] uppercase font-bold">ACTIVE</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span>Slot: {metrics.lastSlot}</span>
          <span className="text-[#00FF88]">SOLANA_TRADER_v2.0.4</span>
        </div>
      </footer>
    </div>
  );
}
