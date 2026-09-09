import React, { useState, useEffect } from 'react';
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  RotateCcw,
  Sliders,
  DollarSign,
  Activity,
  Layers,
  AlertTriangle,
  X,
  Check,
} from 'lucide-react';
import { PaperAccount, PaperPosition, PaperTrade, CopyTradeSettings, BuyEntrySettings, BuyEntryVerdict } from '../types';

interface PaperAccountResponse extends PaperAccount {
  openPositionsValueSol: number;
  totalEquitySol: number;
}

interface WatchlistItem {
  tokenMint: string;
  tokenSymbol: string;
  sourceWalletAddress: string;
  traderName: string;
  firstSeenAt: number;
  lastVerdict: BuyEntryVerdict;
}

const safeJsonFetch = async <T,>(url: string): Promise<T | null> => {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

export const PaperTradingPanel: React.FC = () => {
  const [account, setAccount] = useState<PaperAccountResponse | null>(null);
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [settings, setSettings] = useState<CopyTradeSettings | null>(null);
  const [buyEntrySettings, setBuyEntrySettings] = useState<BuyEntrySettings | null>(null);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);

  // Reset confirmation state
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetBalance, setResetBalance] = useState<number>(10);
  const [isResetting, setIsResetting] = useState(false);
  const [resetSuccessMsg, setResetSuccessMsg] = useState<string | null>(null);
  const refreshInFlight = React.useRef(false);

  const fetchPaperData = async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const [accRes, posRes, trdRes, setRes, buyEntrySetRes, watchlistRes] = await Promise.all([
        safeJsonFetch<PaperAccountResponse>('/api/paper/account'),
        safeJsonFetch<PaperPosition[]>('/api/paper/positions'),
        safeJsonFetch<PaperTrade[]>('/api/paper/trades'),
        safeJsonFetch<CopyTradeSettings>('/api/paper/settings'),
        safeJsonFetch<BuyEntrySettings>('/api/buy-entry/settings'),
        safeJsonFetch<WatchlistItem[]>('/api/buy-entry/watchlist'),
      ]);

      if (accRes) {
        setAccount(accRes);
        if (accRes.startingVirtualSolBalance) {
          setResetBalance(accRes.startingVirtualSolBalance);
        }
      }
      if (Array.isArray(posRes)) setPositions(posRes);
      if (Array.isArray(trdRes)) setTrades(trdRes);
      if (setRes) setSettings(setRes);
      if (buyEntrySetRes) setBuyEntrySettings(buyEntrySetRes);
      if (Array.isArray(watchlistRes)) setWatchlist(watchlistRes);
    } catch {
      // Graceful silent recovery for transient network interruptions
    } finally {
      refreshInFlight.current = false;
    }
  };

  useEffect(() => {
    fetchPaperData();
    const interval = setInterval(fetchPaperData, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleUpdateSettings = async (updates: Partial<CopyTradeSettings>) => {
    if (!settings) return;
    try {
      const res = await fetch('/api/paper/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, ...updates }),
      });
      if (res.ok) {
        const updated = await res.json();
        setSettings(updated);
        if (updates.startingVirtualSolBalance) {
          setResetBalance(updates.startingVirtualSolBalance);
        }
      }
    } catch (err) {
      console.error('Failed to update paper settings:', err);
    }
  };

  const handleUpdateBuyEntrySettings = async (updates: Partial<BuyEntrySettings>) => {
    if (!buyEntrySettings) return;
    try {
      const res = await fetch('/api/buy-entry/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...buyEntrySettings, ...updates }),
      });
      if (res.ok) {
        const updated = await res.json();
        setBuyEntrySettings(updated);
      }
    } catch (err) {
      console.error('Failed to update buy entry settings:', err);
    }
  };

  const handleOpenResetModal = () => {
    setResetBalance(settings?.startingVirtualSolBalance || account?.startingVirtualSolBalance || 10);
    setShowResetModal(true);
  };

  const handleExecuteReset = async () => {
    setIsResetting(true);
    try {
      const res = await fetch('/api/paper/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startingBalance: resetBalance }),
      });
      if (res.ok) {
        await fetchPaperData();
        setShowResetModal(false);
        setResetSuccessMsg('Paper account reset successfully!');
        setTimeout(() => setResetSuccessMsg(null), 3000);
      }
    } catch (err) {
      console.error('Failed to reset paper account:', err);
    } finally {
      setIsResetting(false);
    }
  };

  const openPositions = positions.filter((p) => p.status === 'OPEN');
  const closedPositions = positions.filter((p) => p.status === 'CLOSED');

  // Helper to format hold time
  const formatHoldTime = (startTime: number, endTime: number): string => {
    const durationMs = endTime - startTime;
    const totalSeconds = Math.floor(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  return (
    <div className="space-y-3 font-sans relative">
      {/* Safety Mode Banner */}
      <div className="p-3 rounded bg-[#00FF88]/10 border border-[#00FF88]/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded bg-[#00FF88] text-[#09090b] text-[10px] font-mono font-bold uppercase tracking-wider">
            PAPER TRADING ONLY
          </span>
          <span className="text-xs font-mono text-[#00FF88]">
            Server-side execution guard active (MODE: PAPER). Zero real transaction signing or submission.
          </span>
        </div>
        <span className="text-[10px] font-mono text-[#a1a1aa] bg-[#18181b] px-2 py-1 rounded border border-[#27272a]">
          TP/SL Monitor Active
        </span>
      </div>

      {/* Toast Banner */}
      {resetSuccessMsg && (
        <div className="p-2.5 rounded bg-[#00FF88]/10 border border-[#00FF88]/30 text-[#00FF88] text-xs font-mono flex items-center justify-between animate-fade-in">
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-[#00FF88]" />
            <span>{resetSuccessMsg}</span>
          </div>
          <button onClick={() => setResetSuccessMsg(null)} className="hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Top Header Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <div className="p-3 rounded bg-[#18181b] border border-[#27272a] shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-[#71717a] text-[10px] uppercase font-mono">
            <span>Virtual SOL Balance</span>
            <Wallet className="w-3.5 h-3.5 text-[#00FF88]" />
          </div>
          <div className="mt-2 text-lg font-bold font-mono text-[#fafafa]">
            {account ? `${account.virtualSolBalance.toFixed(3)} SOL` : '—'}
          </div>
          <div className="text-[10px] text-[#71717a] font-mono mt-0.5">
            Initial: {account ? `${account.startingVirtualSolBalance} SOL` : '—'}
          </div>
        </div>

        <div className="p-3 rounded bg-[#18181b] border border-[#27272a] shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-[#71717a] text-[10px] uppercase font-mono">
            <span>Open Positions Value</span>
            <Layers className="w-3.5 h-3.5 text-[#3b82f6]" />
          </div>
          <div className="mt-2 text-lg font-bold font-mono text-[#3b82f6]">
            {account ? `${account.openPositionsValueSol.toFixed(3)} SOL` : '—'}
          </div>
          <div className="text-[10px] text-[#71717a] font-mono mt-0.5">
            {openPositions.length} active position{openPositions.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="p-3 rounded bg-[#18181b] border border-[#27272a] shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-[#71717a] text-[10px] uppercase font-mono">
            <span>Total Equity</span>
            <DollarSign className="w-3.5 h-3.5 text-[#e4e4e7]" />
          </div>
          <div className="mt-2 text-lg font-bold font-mono text-[#fafafa]">
            {account ? `${account.totalEquitySol.toFixed(3)} SOL` : '—'}
          </div>
          <div className="text-[10px] font-mono mt-0.5 text-[#a1a1aa]">
            Liquid + Position Value
          </div>
        </div>

        <div className="p-3 rounded bg-[#18181b] border border-[#27272a] shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-[#71717a] text-[10px] uppercase font-mono">
            <span>Total Realized P&L</span>
            {account && account.totalRealizedPnlSol >= 0 ? (
              <TrendingUp className="w-3.5 h-3.5 text-[#00FF88]" />
            ) : (
              <TrendingDown className="w-3.5 h-3.5 text-[#ff4444]" />
            )}
          </div>
          <div
            className={`mt-2 text-lg font-bold font-mono ${
              account && account.totalRealizedPnlSol >= 0 ? 'text-[#00FF88]' : 'text-[#ff4444]'
            }`}
          >
            {account
              ? `${account.totalRealizedPnlSol >= 0 ? '+' : ''}${account.totalRealizedPnlSol.toFixed(3)} SOL`
              : '—'}
          </div>
          <div className="text-[10px] font-mono mt-0.5 text-[#a1a1aa]">
            {closedPositions.length} trade{closedPositions.length === 1 ? '' : 's'} closed
          </div>
        </div>
      </div>

      {/* Copy Trade Settings Card */}
      <div className="rounded bg-[#18181b] border border-[#27272a] p-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-[#f59e0b]" />
            <h2 className="text-xs font-mono font-bold uppercase text-[#fafafa]">Copy Trade Settings</h2>
          </div>
          <button
            onClick={handleOpenResetModal}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#ff4444] hover:bg-[#ff3333] text-white text-xs font-bold transition-all"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Account</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5">
          <div className="flex flex-col">
            <label className="text-[10px] text-[#71717a] font-mono uppercase mb-1">
              Copy Trading
            </label>
            <label className="flex items-center gap-2 cursor-pointer mt-1">
              <input
                type="checkbox"
                checked={settings?.enabled || false}
                onChange={(e) => handleUpdateSettings({ enabled: e.target.checked })}
                className="w-4 h-4 accent-[#00FF88]"
              />
              <span className="text-[11px] text-[#fafafa] font-mono font-bold">
                {settings?.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </label>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] text-[#71717a] font-mono uppercase mb-1">
              SOL Per Trade
            </label>
            <input
              type="number"
              value={settings?.fixedSolAmountPerTrade ?? 0.5}
              onChange={(e) => handleUpdateSettings({ fixedSolAmountPerTrade: parseFloat(e.target.value) || 0.1 })}
              step={0.01}
              min={0.01}
              className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
            />
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] text-[#71717a] font-mono uppercase mb-1">
              Take Profit (%)
            </label>
            <input
              type="number"
              value={settings?.takeProfitPercent ?? 30}
              onChange={(e) => handleUpdateSettings({ takeProfitPercent: parseFloat(e.target.value) || 0 })}
              step={1}
              min={1}
              className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#00FF88] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
            />
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] text-[#71717a] font-mono uppercase mb-1">
              Stop Loss (%)
            </label>
            <input
              type="number"
              value={settings?.stopLossPercent ?? 15}
              onChange={(e) => handleUpdateSettings({ stopLossPercent: parseFloat(e.target.value) || 0 })}
              step={1}
              min={1}
              className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#ff4444] font-mono text-xs focus:outline-none focus:border-[#ff4444]"
            />
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] text-[#71717a] font-mono uppercase mb-1">
              Slippage (bps)
            </label>
            <input
              type="number"
              value={settings?.simulatedSlippageBps ?? 50}
              onChange={(e) => handleUpdateSettings({ simulatedSlippageBps: parseFloat(e.target.value) || 0 })}
              step={1}
              min={0}
              className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
            />
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] text-[#71717a] font-mono uppercase mb-1">
              Starting Balance
            </label>
            <input
              type="number"
              value={settings?.startingVirtualSolBalance ?? 10}
              onChange={(e) => handleUpdateSettings({ startingVirtualSolBalance: parseFloat(e.target.value) || 1 })}
              step={0.1}
              min={0.1}
              className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
            />
          </div>
        </div>
      </div>

      {/* Buy Entry Signal Engine Gates Card */}
      <div className="rounded bg-[#18181b] border border-[#27272a] p-3 space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-[#27272a]">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#3b82f6]" />
            <h2 className="text-xs font-mono font-bold uppercase text-[#fafafa]">Multi-Gate Buy Entry Signals</h2>
          </div>
          <span className="text-[10px] font-mono text-[#71717a]">
            {buyEntrySettings?.enabled ? 'GATING ACTIVE' : 'DISABLED (MIRROR ALL)'}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          <div className="flex flex-col">
            <label className="text-[10px] text-[#71717a] font-mono uppercase mb-1">
              Buy Entry Gates
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={buyEntrySettings?.enabled || false}
                onChange={(e) => handleUpdateBuyEntrySettings({ enabled: e.target.checked })}
                className="w-4 h-4 accent-[#3b82f6]"
              />
              <span className="text-[11px] text-[#fafafa] font-mono font-bold">
                {buyEntrySettings?.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </label>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] text-[#71717a] font-mono uppercase mb-1">
              Min Momentum Score
            </label>
            <input
              type="number"
              value={buyEntrySettings?.minMomentumScoreToBuy ?? 75}
              onChange={(e) =>
                handleUpdateBuyEntrySettings({ minMomentumScoreToBuy: parseInt(e.target.value, 10) || 0 })
              }
              step={1}
              min={0}
              max={100}
              className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#3b82f6]"
            />
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] text-[#71717a] font-mono uppercase mb-1">
              Max Acceptable Risk
            </label>
            <select
              value={buyEntrySettings?.maxAcceptableRiskLevel || 'MEDIUM'}
              onChange={(e) =>
                handleUpdateBuyEntrySettings({
                  maxAcceptableRiskLevel: e.target.value as 'LOW' | 'MEDIUM' | 'HIGH',
                })
              }
              className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#3b82f6]"
            >
              <option value="LOW">LOW</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="HIGH">HIGH</option>
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] text-[#71717a] font-mono uppercase mb-1">
              Watch Window (Mins)
            </label>
            <input
              type="number"
              value={buyEntrySettings?.watchWindowMinutes ?? 15}
              onChange={(e) =>
                handleUpdateBuyEntrySettings({ watchWindowMinutes: parseInt(e.target.value, 10) || 1 })
              }
              step={1}
              min={1}
              className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#3b82f6]"
            />
          </div>
        </div>

        {/* Live Candidate Watchlist */}
        <div className="pt-2 border-t border-[#27272a]/60">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono font-bold uppercase text-[#a1a1aa]">
                Live Signal Watchlist ({watchlist.length})
              </span>
            </div>
            <span className="text-[9px] font-mono text-[#71717a]">
              Auto-reevaluated every 30s
            </span>
          </div>

          <div className="overflow-x-auto max-h-[220px] overflow-y-auto scrollbar-thin scrollbar-thumb-[#27272a]">
            <table className="w-full text-left font-mono text-[10px]">
              <thead className="sticky top-0 bg-[#18181b] border-b border-[#27272a] text-[#71717a] uppercase text-[8px] z-10">
                <tr>
                  <th className="py-1 px-2">Token</th>
                  <th className="py-1 px-2">Trader</th>
                  <th className="py-1 px-2 text-center">Score</th>
                  <th className="py-1 px-2 text-center">Verdict</th>
                  <th className="py-1 px-2">Reasons & Analysis</th>
                  <th className="py-1 px-2 text-right">Data Gaps</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#27272a]/40">
                {watchlist.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-[#71717a] text-xs">
                      No buy candidates currently queued in watchlist.
                    </td>
                  </tr>
                ) : (
                  watchlist.map((item) => {
                    const verdict = item.lastVerdict;
                    const verdictColor =
                      verdict?.verdict === 'BUY'
                        ? 'bg-[#00FF88]/15 text-[#00FF88] border-[#00FF88]/30'
                        : verdict?.verdict === 'WATCH' || verdict?.verdict === 'READY_TO_BUY'
                        ? 'bg-[#f59e0b]/15 text-[#f59e0b] border-[#f59e0b]/30'
                        : 'bg-[#ff4444]/15 text-[#ff4444] border-[#ff4444]/30';

                    return (
                      <tr key={`${item.sourceWalletAddress}:${item.tokenMint}`} className="hover:bg-[#27272a]/20">
                        <td className="py-1.5 px-2 font-bold text-[#3b82f6]">{item.tokenSymbol}</td>
                        <td className="py-1.5 px-2 text-[#fafafa]">{item.traderName}</td>
                        <td className="py-1.5 px-2 text-center font-bold text-[#fafafa]">
                          {verdict?.momentumScore ?? '—'}
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold border ${verdictColor}`}>
                            {verdict?.verdict || 'PENDING'}
                          </span>
                        </td>
                        <td className="py-1.5 px-2 text-[#a1a1aa] text-[9px] max-w-[250px] truncate">
                          {verdict?.reasons?.join('; ') || 'Evaluating...'}
                        </td>
                        <td className="py-1.5 px-2 text-right text-[#71717a] text-[8px] max-w-[150px] truncate">
                          {verdict?.dataGaps?.length ? `${verdict.dataGaps.length} gaps` : 'None'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Reset Modal */}
      {showResetModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 rounded">
          <div className="bg-[#18181b] border border-[#27272a] rounded p-4 max-w-sm w-full mx-4 shadow-lg">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-[#ff4444]" />
              <h3 className="text-sm font-bold text-[#fafafa] uppercase font-mono">Reset Paper Account?</h3>
            </div>

            <p className="text-xs text-[#a1a1aa] mb-4">
              This will clear all open positions and trade history. All balances will be reset to the starting amount.
            </p>

            <div className="mb-4">
              <label className="text-[10px] text-[#71717a] font-mono uppercase block mb-1">
                Starting Balance (SOL)
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={resetBalance}
                  onChange={(e) => setResetBalance(parseFloat(e.target.value))}
                  step={0.1}
                  min={0.1}
                  className="flex-1 px-3 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-bold text-sm focus:outline-none focus:border-[#00FF88]"
                />
                <span className="text-xs text-[#71717a] font-bold">SOL</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#27272a]">
              <button
                onClick={() => setShowResetModal(false)}
                className="px-3 py-1.5 rounded bg-[#27272a] hover:bg-[#3f3f46] text-[#a1a1aa] text-xs font-bold"
                disabled={isResetting}
              >
                Cancel
              </button>
              <button
                onClick={handleExecuteReset}
                disabled={isResetting}
                className="px-4 py-1.5 rounded bg-[#ff4444] hover:bg-[#ff3333] text-white text-xs font-bold shadow transition-all flex items-center gap-1.5"
              >
                <RotateCcw className={`w-3.5 h-3.5 ${isResetting ? 'animate-spin' : ''}`} />
                <span>{isResetting ? 'Resetting...' : 'Confirm Reset'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Grid: Open Positions & Recent Trades */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Open Paper Positions */}
        <div className="rounded bg-[#18181b] border border-[#27272a] p-3 flex flex-col space-y-2">
          <div className="flex items-center justify-between pb-2 border-b border-[#27272a]">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-[#3b82f6]" />
              <h2 className="text-xs font-mono font-bold uppercase text-[#fafafa]">
                Open Paper Positions ({openPositions.length})
              </h2>
            </div>
            <span className="text-[10px] font-mono text-[#71717a]">
              Mirrored from Monitored Wallets
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-[10px]">
              <thead>
                <tr className="border-b border-[#27272a] text-[#71717a] uppercase text-[8px]">
                  <th className="py-1.5 px-2">Trader / Token</th>
                  <th className="py-1.5 px-2 text-right">Quantity</th>
                  <th className="py-1.5 px-2 text-right">Entry / Current</th>
                  <th className="py-1.5 px-2 text-center">TP / SL Targets</th>
                  <th className="py-1.5 px-2 text-right">Unrealized P&L</th>
                  <th className="py-1.5 px-2 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#27272a]/40">
                {openPositions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-[#71717a] text-xs">
                      No open paper positions. Enable copy trading to mirror wallet buys automatically.
                    </td>
                  </tr>
                ) : (
                  openPositions.map((p) => {
                    const uPnl = (p.currentPriceSol - p.avgEntryPriceSol) * p.quantity;
                    const uRoi =
                      p.avgEntryPriceSol > 0
                        ? ((p.currentPriceSol - p.avgEntryPriceSol) / p.avgEntryPriceSol) * 100
                        : 0;
                    return (
                      <tr key={p.id} className="hover:bg-[#27272a]/20 transition-colors">
                        <td className="py-2 px-2">
                          <div className="font-bold text-[#fafafa] text-xs">{p.traderName}</div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[#3b82f6] font-bold">{p.tokenSymbol}</span>
                            <span className="px-1 py-0.2 rounded bg-[#00FF88]/10 text-[#00FF88] text-[8px] border border-[#00FF88]/20">
                              PAPER
                            </span>
                          </div>
                        </td>
                        <td className="py-2 px-2 text-right text-[#e4e4e7]">
                          {p.quantity >= 1000
                            ? p.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })
                            : p.quantity.toFixed(4)}
                        </td>
                        <td className="py-2 px-2 text-right">
                          <div className="text-[#71717a]">
                            Entry: {p.avgEntryPriceSol < 0.0001 ? p.avgEntryPriceSol.toExponential(2) : p.avgEntryPriceSol.toFixed(6)}
                          </div>
                          <div className="text-[#e4e4e7] font-bold">
                            Cur: {p.currentPriceSol < 0.0001 ? p.currentPriceSol.toExponential(2) : p.currentPriceSol.toFixed(6)}
                          </div>
                        </td>
                        <td className="py-2 px-2 text-center text-[9px]">
                          <div className="text-[#00FF88]">
                            TP ({p.takeProfitPercent || 30}%): {p.takeProfitPriceSol ? (p.takeProfitPriceSol < 0.0001 ? p.takeProfitPriceSol.toExponential(2) : p.takeProfitPriceSol.toFixed(6)) : '—'}
                          </div>
                          <div className="text-[#ff4444]">
                            SL ({p.stopLossPercent || 15}%): {p.stopLossPriceSol ? (p.stopLossPriceSol < 0.0001 ? p.stopLossPriceSol.toExponential(2) : p.stopLossPriceSol.toFixed(6)) : '—'}
                          </div>
                        </td>
                        <td className="py-2 px-2 text-right font-bold">
                          <span className={uPnl >= 0 ? 'text-[#00FF88]' : 'text-[#ff4444]'}>
                            {uPnl >= 0 ? '+' : ''}
                            {uPnl.toFixed(3)} SOL ({uRoi >= 0 ? '+' : ''}
                            {uRoi.toFixed(1)}%)
                          </span>
                        </td>
                        <td className="py-2 px-2 text-center">
                          <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-[#3b82f6]/20 text-[#3b82f6] border border-[#3b82f6]/30">
                            {p.status || 'OPEN'}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Enhanced Paper Trade History - WITH SOLD AMOUNT & P&L */}
        <div className="rounded bg-[#18181b] border border-[#27272a] p-3 flex flex-col space-y-2">
          <div className="flex items-center justify-between pb-2 border-b border-[#27272a]">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#00FF88]" />
              <h2 className="text-xs font-mono font-bold uppercase text-[#fafafa]">
                Executed Paper Trades ({trades.length})
              </h2>
            </div>
            <span className="text-[10px] font-mono text-[#71717a]">Full Trade Details</span>
          </div>

          <div className="overflow-x-auto max-h-[400px] overflow-y-auto scrollbar-thin scrollbar-thumb-[#27272a]">
            <table className="w-full text-left font-mono text-[9px]">
              <thead className="sticky top-0 bg-[#18181b] border-b border-[#27272a] text-[#71717a] uppercase text-[8px] z-10">
                <tr>
                  <th className="py-1 px-1.5">Time</th>
                  <th className="py-1 px-1.5">Trader</th>
                  <th className="py-1 px-1.5">Action</th>
                  <th className="py-1 px-1.5">Token</th>
                  <th className="py-1 px-1.5 text-right">Qty</th>
                  <th className="py-1 px-1.5 text-right">Price</th>
                  <th className="py-1 px-1.5 text-right">SOL</th>
                  <th className="py-1 px-1.5 text-right">Entry</th>
                  <th className="py-1 px-1.5 text-right">P&L</th>
                  <th className="py-1 px-1.5 text-right">Hold</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#27272a]/40">
                {trades.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-6 text-center text-[#71717a] text-xs">
                      No paper trades recorded yet.
                    </td>
                  </tr>
                ) : (
                  trades.map((t) => {
                    const timeStr = new Date(t.timestamp).toLocaleTimeString();
                    const isSell = t.action === 'SELL';
                    
                    // Get corresponding position for entry price & hold time
                    const position = positions.find(
                      (p) => p.sourceWalletAddress === t.sourceWalletAddress && p.tokenMint === t.tokenMint
                    );
                    
                    let holdTimeStr = '—';
                    if (isSell && position?.exitTimestamp) {
                      holdTimeStr = formatHoldTime(position.entryTimestamp, position.exitTimestamp);
                    }
                    
                    const entryPrice = position?.avgEntryPriceSol || (isSell ? '—' : t.executionPriceSol);
                    
                    // For sell trades, try to find realized P&L from closed position
                    let pnlDisplay = '—';
                    let pnlColor = 'text-[#71717a]';
                    if (isSell && position?.status === 'CLOSED') {
                      pnlDisplay = `${position.realizedPnlSol >= 0 ? '+' : ''}${position.realizedPnlSol.toFixed(3)}`;
                      pnlColor = position.realizedPnlSol >= 0 ? 'text-[#00FF88]' : 'text-[#ff4444]';
                    }
                    
                    return (
                      <tr key={t.id} className="hover:bg-[#27272a]/20 transition-colors">
                        <td className="py-1.5 px-1.5 text-[#71717a] text-[8px]">{timeStr}</td>
                        <td className="py-1.5 px-1.5 font-bold text-[#fafafa] text-[9px]">{t.traderName}</td>
                        <td className="py-1.5 px-1.5">
                          <span
                            className={`px-1 py-0.5 rounded text-[7px] font-bold whitespace-nowrap ${
                              t.action === 'BUY'
                                ? 'bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30'
                                : 'bg-[#ff4444]/15 text-[#ff4444] border border-[#ff4444]/30'
                            }`}
                          >
                            {t.action}
                          </span>
                        </td>
                        <td className="py-1.5 px-1.5 font-bold text-[#3b82f6] text-[9px]">{t.tokenSymbol}</td>
                        
                        {/* Quantity Sold - NEW COLUMN */}
                        <td className="py-1.5 px-1.5 text-right text-[#e4e4e7]">
                          {t.tokenAmount >= 1000
                            ? t.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })
                            : t.tokenAmount.toFixed(4)}
                        </td>
                        
                        {/* Fill Price */}
                        <td className="py-1.5 px-1.5 text-right text-[#e4e4e7]">
                          {t.executionPriceSol < 0.0001
                            ? t.executionPriceSol.toExponential(2)
                            : t.executionPriceSol.toFixed(6)}
                        </td>
                        
                        {/* SOL Amount */}
                        <td className={`py-1.5 px-1.5 text-right font-bold ${
                          t.action === 'BUY' ? 'text-[#ff9500]' : 'text-[#00FF88]'
                        }`}>
                          {t.solAmount.toFixed(3)}
                        </td>
                        
                        {/* Entry Price - NEW COLUMN (for SELL trades) */}
                        <td className="py-1.5 px-1.5 text-right text-[#71717a]">
                          {typeof entryPrice === 'number'
                            ? entryPrice < 0.0001
                              ? entryPrice.toExponential(2)
                              : entryPrice.toFixed(6)
                            : entryPrice}
                        </td>
                        
                        {/* Realized P&L - NEW COLUMN (for SELL trades) */}
                        <td className={`py-1.5 px-1.5 text-right font-bold text-[8px] ${pnlColor}`}>
                          {pnlDisplay}
                        </td>
                        
                        {/* Hold Duration - NEW COLUMN */}
                        <td className="py-1.5 px-1.5 text-right text-[#71717a] text-[8px]">
                          {holdTimeStr}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Closed Positions / Trade Journal */}
      {closedPositions.length > 0 && (
        <div className="rounded bg-[#18181b] border border-[#27272a] p-3 flex flex-col space-y-2">
          <div className="flex items-center justify-between pb-2 border-b border-[#27272a]">
            <div className="flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-[#ff9500]" />
              <h2 className="text-xs font-mono font-bold uppercase text-[#fafafa]">
                Trade Journal - Closed Positions ({closedPositions.length})
              </h2>
            </div>
            <span className="text-[10px] font-mono text-[#71717a]">
              Historical Performance Analysis
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-[10px]">
              <thead>
                <tr className="border-b border-[#27272a] text-[#71717a] uppercase text-[8px]">
                  <th className="py-1.5 px-2">Trader</th>
                  <th className="py-1.5 px-2">Token</th>
                  <th className="py-1.5 px-2 text-right">Entry</th>
                  <th className="py-1.5 px-2 text-right">Exit</th>
                  <th className="py-1.5 px-2 text-right">Qty</th>
                  <th className="py-1.5 px-2 text-right">Cost</th>
                  <th className="py-1.5 px-2 text-right">Proceeds</th>
                  <th className="py-1.5 px-2 text-right">P&L</th>
                  <th className="py-1.5 px-2 text-right">ROI %</th>
                  <th className="py-1.5 px-2 text-right">Hold Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#27272a]/40">
                {closedPositions.map((p) => {
                  const holdTimeStr = formatHoldTime(p.entryTimestamp, p.exitTimestamp || p.lastTradeTimestamp);
                  const proceeds = p.realizedPnlSol + p.costBasisSol;
                  
                  return (
                    <tr key={p.id} className="hover:bg-[#27272a]/20 transition-colors">
                      <td className="py-2 px-2 font-bold text-[#fafafa]">{p.traderName}</td>
                      <td className="py-2 px-2 text-[#3b82f6] font-bold">{p.tokenSymbol}</td>
                      <td className="py-2 px-2 text-right text-[#71717a]">
                        {p.avgEntryPriceSol < 0.0001
                          ? p.avgEntryPriceSol.toExponential(2)
                          : p.avgEntryPriceSol.toFixed(6)}
                      </td>
                      <td className="py-2 px-2 text-right text-[#e4e4e7]">
                        {p.currentPriceSol < 0.0001
                          ? p.currentPriceSol.toExponential(2)
                          : p.currentPriceSol.toFixed(6)}
                      </td>
                      <td className="py-2 px-2 text-right text-[#e4e4e7]">
                        {p.quantity >= 1000
                          ? p.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })
                          : p.quantity.toFixed(4)}
                      </td>
                      <td className="py-2 px-2 text-right text-[#71717a]">
                        {p.costBasisSol.toFixed(3)}
                      </td>
                      <td className="py-2 px-2 text-right text-[#00FF88]">
                        {proceeds.toFixed(3)}
                      </td>
                      <td className="py-2 px-2 text-right font-bold">
                        <span className={p.realizedPnlSol >= 0 ? 'text-[#00FF88]' : 'text-[#ff4444]'}>
                          {p.realizedPnlSol >= 0 ? '+' : ''}
                          {p.realizedPnlSol.toFixed(3)}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right font-bold">
                        <span className={p.roiPercent >= 0 ? 'text-[#00FF88]' : 'text-[#ff4444]'}>
                          {p.roiPercent >= 0 ? '+' : ''}
                          {p.roiPercent.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right text-[#71717a]">
                        {holdTimeStr}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
