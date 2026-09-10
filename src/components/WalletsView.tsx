import React, { useState, useEffect } from 'react';
import {
  Plus,
  Search,
  Users,
  Trash2,
  Edit2,
  Check,
  X,
  ExternalLink,
  AlertCircle,
  Compass,
  Sparkles,
  RefreshCw,
  TrendingUp,
  ShieldAlert,
} from 'lucide-react';
import { TraderWallet, Position, CanonicalTradeEvent, DiscoveredWallet } from '../types';
import { formatAddress, formatSol } from '../utils/formatters';

interface WalletsViewProps {
  wallets: TraderWallet[];
  positions: Position[];
  trades: CanonicalTradeEvent[];
  onAddWallet: (walletData: any) => Promise<void>;
  onUpdateWallet: (address: string, updates: Partial<TraderWallet>) => Promise<void>;
  onDeleteWallet: (address: string) => Promise<void>;
}

export const WalletsView: React.FC<WalletsViewProps> = ({
  wallets,
  positions,
  trades,
  onAddWallet,
  onUpdateWallet,
  onDeleteWallet,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('ALL');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedTrader, setSelectedTrader] = useState<TraderWallet | null>(null);

  // Smart Wallet Discovery State
  const [discoveredWallets, setDiscoveredWallets] = useState<DiscoveredWallet[]>([]);
  const [isScanningDiscovery, setIsScanningDiscovery] = useState(false);
  const [showDiscovery, setShowDiscovery] = useState(true);

  const fetchDiscovery = async () => {
    try {
      const res = await fetch('/api/discovery');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setDiscoveredWallets(data);
      }
    } catch {
      // Ignore network errors gracefully
    }
  };

  const handleRunDiscoveryScan = async () => {
    setIsScanningDiscovery(true);
    try {
      const res = await fetch('/api/discovery/scan', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.wallets) setDiscoveredWallets(data.wallets);
      }
    } catch (err) {
      console.error('Failed to run discovery scan', err);
    } finally {
      setIsScanningDiscovery(false);
    }
  };

  useEffect(() => {
    fetchDiscovery();
  }, []);

  const handleAddDiscovered = async (w: DiscoveredWallet) => {
    try {
      await onAddWallet({
        address: w.address,
        traderName: w.traderName,
        description: `Discovered Smart Money (${w.winRatePercent}% Win Rate)`,
        group: 'Smart Money',
        priority: 'HIGH',
      });
    } catch (err: any) {
      alert(err?.message || 'Failed to add discovered wallet.');
    }
  };

  // Form State
  const [addressInput, setAddressInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [descInput, setDescInput] = useState('');
  const [groupInput, setGroupInput] = useState('Smart Money');
  const [priorityInput, setPriorityInput] = useState<'HIGH' | 'MEDIUM' | 'LOW'>('HIGH');
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const filteredWallets = wallets.filter((w) => {
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const matchName = w.traderName.toLowerCase().includes(q);
      const matchAddr = w.address.toLowerCase().includes(q);
      const matchDesc = w.description.toLowerCase().includes(q);
      if (!matchName && !matchAddr && !matchDesc) return false;
    }
    if (selectedGroup !== 'ALL' && w.group !== selectedGroup) return false;
    return true;
  });

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setLoading(true);

    try {
      await onAddWallet({
        address: addressInput.trim(),
        traderName: nameInput.trim() || (addressInput.trim().length > 8 ? `Trader ${formatAddress(addressInput.trim())}` : addressInput.trim()),
        description: descInput.trim() || 'Monitored Smart Money Wallet',
        group: groupInput,
        priority: priorityInput,
      });

      // Reset form
      setAddressInput('');
      setNameInput('');
      setDescInput('');
      setIsAddModalOpen(false);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to add wallet. Validate address format.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 font-mono">
      {/* Smart Wallet Discovery Scanner */}
      <div className="bg-[#18181b] border border-[#27272a] rounded p-3 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#27272a] pb-2">
          <div className="flex items-center gap-2">
            <Compass className="w-4 h-4 text-[#3b82f6]" />
            <h2 className="text-xs font-bold text-[#fafafa] uppercase tracking-wider flex items-center gap-1.5">
              SMART WALLET DISCOVERY SCANNER
              <span className="px-1.5 py-0.5 text-[9px] bg-[#3b82f6]/15 text-[#3b82f6] rounded border border-[#3b82f6]/30">
                AUTO-SCAN
              </span>
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRunDiscoveryScan}
              disabled={isScanningDiscovery}
              className="flex items-center gap-1 px-2 py-1 rounded bg-[#09090b] border border-[#27272a] hover:border-[#3b82f6] text-[#fafafa] text-[10px] font-bold transition-all disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${isScanningDiscovery ? 'animate-spin text-[#3b82f6]' : ''}`} />
              {isScanningDiscovery ? 'Scanning DexScreener...' : 'Run Discovery Scan'}
            </button>
            <button
              onClick={() => setShowDiscovery(!showDiscovery)}
              className="text-[10px] text-[#71717a] hover:text-[#fafafa] underline"
            >
              {showDiscovery ? 'Hide' : 'Show'} ({discoveredWallets.length})
            </button>
          </div>
        </div>

        {showDiscovery && (
          <div className="overflow-x-auto">
            {discoveredWallets.length === 0 ? (
              <div className="p-4 text-center text-[#71717a] text-[11px]">
                No discovered wallets cached yet. Click "Run Discovery Scan" to search DexScreener momentum leaders.
              </div>
            ) : (
              <table className="w-full text-left text-[11px] border-collapse">
                <thead>
                  <tr className="border-b border-[#27272a] text-[#71717a] uppercase text-[9px]">
                    <th className="py-1.5 px-2">Trader Name</th>
                    <th className="py-1.5 px-2">Address</th>
                    <th className="py-1.5 px-2">Win Rate</th>
                    <th className="py-1.5 px-2">Total Trades</th>
                    <th className="py-1.5 px-2">Risk Score</th>
                    <th className="py-1.5 px-2">Recent P&L</th>
                    <th className="py-1.5 px-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#27272a]/50">
                  {discoveredWallets.map((dw) => {
                    const isAlreadyAdded = wallets.some(
                      (w) => w.address.toLowerCase() === dw.address.toLowerCase()
                    );
                    return (
                      <tr key={dw.address} className="hover:bg-[#09090b]/50 transition-colors">
                        <td className="py-1.5 px-2 font-bold text-[#fafafa]">
                          <div className="flex items-center gap-1">
                            <Sparkles className="w-3 h-3 text-[#f59e0b]" />
                            {dw.traderName}
                          </div>
                        </td>
                        <td className="py-1.5 px-2 text-[#71717a] font-mono">{formatAddress(dw.address)}</td>
                        <td className="py-1.5 px-2 text-[#00FF88] font-bold">{dw.winRatePercent}%</td>
                        <td className="py-1.5 px-2 text-[#a1a1aa]">{dw.totalTrades}</td>
                        <td className="py-1.5 px-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                              dw.riskScore <= 30
                                ? 'bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30'
                                : 'bg-[#f59e0b]/15 text-[#f59e0b] border border-[#f59e0b]/30'
                            }`}
                          >
                            Score {dw.riskScore}
                          </span>
                        </td>
                        <td className="py-1.5 px-2 font-bold text-[#00FF88]">+{dw.recentPnlSol.toFixed(2)} SOL</td>
                        <td className="py-1.5 px-2 text-right">
                          <button
                            onClick={() => handleAddDiscovered(dw)}
                            disabled={isAlreadyAdded}
                            className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all ${
                              isAlreadyAdded
                                ? 'bg-[#27272a] text-[#71717a] cursor-not-allowed'
                                : 'bg-[#00FF88] text-[#09090b] hover:bg-[#00e67a]'
                            }`}
                          >
                            {isAlreadyAdded ? 'MONITORED' : '+ Add to Copy'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Top Header & Search Bar */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 bg-[#18181b] border border-[#27272a] rounded p-3">
        <div>
          <h2 className="text-xs font-bold text-[#fafafa] uppercase tracking-wider flex items-center gap-2">
            <Users className="w-4 h-4 text-[#00FF88]" />
            MONITORED TRADER WALLETS ({wallets.length})
          </h2>
          <p className="text-[10px] text-[#71717a] mt-0.5 font-mono">
            LaserStream account-filtering streams transactions for all enabled trader wallets.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <div className="relative flex-1 md:w-60">
            <Search className="w-3 h-3 absolute left-2.5 top-2.5 text-[#71717a]" />
            <input
              type="text"
              placeholder="Search trader name or wallet..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-7 pr-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[11px] text-[#fafafa] placeholder:text-[#71717a] focus:outline-none focus:border-[#00FF88]"
            />
          </div>

          <select
            value={selectedGroup}
            onChange={(e) => setSelectedGroup(e.target.value)}
            className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[11px] text-[#fafafa] focus:outline-none focus:border-[#00FF88]"
          >
            <option value="ALL">All Groups</option>
            <option value="Smart Money">Smart Money</option>
            <option value="Whales">Whales</option>
            <option value="Insiders">Insiders</option>
            <option value="Alpha">Alpha</option>
            <option value="Scalpers">Scalpers</option>
          </select>

          <button
            onClick={() => setIsAddModalOpen(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#00FF88] text-[#09090b] font-bold text-[11px] hover:bg-[#00e67a] transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Wallet
          </button>
        </div>
      </div>

      {/* Wallets Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filteredWallets.map((w, idx) => {
          const traderPositions = positions.filter(
            (p) => p.walletAddress.toLowerCase() === w.address.toLowerCase()
          );
          const openPositions = traderPositions.filter((p) => p.status === 'OPEN');

          return (
            <div
              key={`${w.id}_${idx}`}
              className="bg-[#18181b] border border-[#27272a] rounded p-3 flex flex-col justify-between hover:border-[#00FF88]/40 transition-all shadow-sm"
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-[#fafafa] text-xs">
                        {w.traderName}
                      </h3>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#3b82f6]/15 text-[#3b82f6] border border-[#3b82f6]/30">
                        {w.group}
                      </span>
                    </div>
                    <p className="text-[10px] text-[#71717a] line-clamp-1 mt-0.5">{w.description}</p>
                  </div>

                  <button
                    onClick={() => onUpdateWallet(w.address, { enabled: !w.enabled })}
                    title={w.enabled ? 'Disable Monitoring' : 'Enable Monitoring'}
                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                      w.enabled
                        ? 'bg-[#00FF88]/15 text-[#00FF88] border-[#00FF88]/30'
                        : 'bg-[#09090b] text-[#71717a] border-[#27272a]'
                    }`}
                  >
                    {w.enabled ? 'ACTIVE' : 'DISABLED'}
                  </button>
                </div>

                <div className="p-2 rounded bg-[#09090b] border border-[#27272a] mb-2 text-[10px] flex items-center justify-between">
                  <span className="text-[#71717a]">Address:</span>
                  <span className="text-[#fafafa] font-semibold truncate max-w-[170px]">
                    {w.address}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-1.5 text-[10px] mb-2">
                  <div className="p-1.5 rounded bg-[#09090b] border border-[#27272a]">
                    <span className="text-[#71717a] block">SOL Balance:</span>
                    <span className="font-bold text-[#00FF88]">{formatSol(w.solBalance)}</span>
                  </div>
                  <div className="p-1.5 rounded bg-[#09090b] border border-[#27272a]">
                    <span className="text-[#71717a] block">Win Rate:</span>
                    <span className="font-bold text-[#3b82f6]">{w.metrics.winRatePercent}%</span>
                  </div>
                  <div className="p-1.5 rounded bg-[#09090b] border border-[#27272a]">
                    <span className="text-[#71717a] block">Realized P&L:</span>
                    <span
                      className={`font-bold ${
                        w.metrics.realizedPnlSol >= 0 ? 'text-[#00FF88]' : 'text-[#ef4444]'
                      }`}
                    >
                      {w.metrics.realizedPnlSol >= 0 ? '+' : ''}
                      {w.metrics.realizedPnlSol} SOL
                    </span>
                  </div>
                  <div className="p-1.5 rounded bg-[#09090b] border border-[#27272a]">
                    <span className="text-[#71717a] block">Active Positions:</span>
                    <span className="font-bold text-[#fafafa]">{openPositions.length} open</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-[#27272a] gap-2">
                <button
                  onClick={() => setSelectedTrader(w)}
                  className="flex-1 py-1 rounded bg-[#09090b] border border-[#27272a] hover:border-[#00FF88] text-[#fafafa] text-[10px] font-bold transition-colors text-center"
                >
                  Performance Analytics
                </button>

                <button
                  onClick={() => onDeleteWallet(w.address)}
                  title="Delete Trader Wallet"
                  className="p-1 rounded bg-[#ef4444]/10 hover:bg-[#ef4444]/20 text-[#ef4444] border border-[#ef4444]/20"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Wallet Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#09090b]/90 backdrop-blur-sm">
          <div className="bg-[#18181b] border border-[#27272a] rounded max-w-md w-full p-5 shadow-2xl relative font-mono">
            <button
              onClick={() => setIsAddModalOpen(false)}
              className="absolute top-4 right-4 p-1 rounded bg-[#09090b] border border-[#27272a] text-[#71717a] hover:text-[#fafafa]"
            >
              <X className="w-4 h-4" />
            </button>

            <h3 className="text-xs font-bold text-[#fafafa] uppercase tracking-wider mb-3">
              ADD SOLANA TRADER WALLET
            </h3>

            {errorMsg && (
              <div className="p-2 mb-3 rounded bg-[#ef4444]/10 border border-[#ef4444]/30 text-[#ef4444] text-[10px] flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <form onSubmit={handleCreateSubmit} className="space-y-2.5 text-[11px]">
              <div>
                <label className="text-[#71717a] block mb-1 font-semibold">
                  Solana Address (Base58):
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
                  value={addressInput}
                  onChange={(e) => setAddressInput(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] focus:outline-none focus:border-[#00FF88]"
                />
              </div>

              <div>
                <label className="text-[#71717a] block mb-1 font-semibold">Trader Name:</label>
                <input
                  type="text"
                  placeholder="e.g. Smart Money 01"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] focus:outline-none focus:border-[#00FF88]"
                />
              </div>

              <div>
                <label className="text-[#71717a] block mb-1 font-semibold">Description:</label>
                <input
                  type="text"
                  placeholder="e.g. Top Memecoin Early Accumulator"
                  value={descInput}
                  onChange={(e) => setDescInput(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] focus:outline-none focus:border-[#00FF88]"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[#71717a] block mb-1 font-semibold">Group:</label>
                  <select
                    value={groupInput}
                    onChange={(e) => setGroupInput(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] focus:outline-none"
                  >
                    <option value="Smart Money">Smart Money</option>
                    <option value="Whales">Whales</option>
                    <option value="Insiders">Insiders</option>
                    <option value="Alpha">Alpha</option>
                    <option value="Scalpers">Scalpers</option>
                  </select>
                </div>

                <div>
                  <label className="text-[#71717a] block mb-1 font-semibold">Priority:</label>
                  <select
                    value={priorityInput}
                    onChange={(e) => setPriorityInput(e.target.value as any)}
                    className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] focus:outline-none"
                  >
                    <option value="HIGH">HIGH</option>
                    <option value="MEDIUM">MEDIUM</option>
                    <option value="LOW">LOW</option>
                  </select>
                </div>
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-3 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#71717a] hover:text-[#fafafa] font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-3 py-1.5 rounded bg-[#00FF88] text-[#09090b] font-bold hover:bg-[#00e67a] disabled:opacity-50"
                >
                  {loading ? 'Validating...' : 'Save & Monitor'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Dedicated Trader Performance Modal Page */}
      {selectedTrader && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#09090b]/90 backdrop-blur-sm overflow-y-auto">
          <div className="bg-[#18181b] border border-[#27272a] rounded max-w-2xl w-full p-5 shadow-2xl relative my-8 font-mono">
            <button
              onClick={() => setSelectedTrader(null)}
              className="absolute top-4 right-4 p-1 rounded bg-[#09090b] border border-[#27272a] text-[#71717a] hover:text-[#fafafa]"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-2 mb-4">
              <div className="p-1.5 rounded bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30">
                <Users className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-[#fafafa]">
                  {selectedTrader.traderName}
                </h3>
                <p className="text-[10px] text-[#71717a]">{selectedTrader.address}</p>
              </div>
            </div>

            {/* Performance Metrics Breakdown */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 text-[11px]">
              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <span className="text-[#71717a] block">SOL Balance:</span>
                <span className="text-sm font-bold text-[#00FF88]">
                  {formatSol(selectedTrader.solBalance)}
                </span>
              </div>
              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <span className="text-[#71717a] block">Win Rate:</span>
                <span className="text-sm font-bold text-[#3b82f6]">
                  {selectedTrader.metrics.winRatePercent}%
                </span>
              </div>
              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <span className="text-[#71717a] block">Realized P&L:</span>
                <span
                  className={`text-sm font-bold ${
                    selectedTrader.metrics.realizedPnlSol >= 0 ? 'text-[#00FF88]' : 'text-[#ef4444]'
                  }`}
                >
                  +{selectedTrader.metrics.realizedPnlSol} SOL
                </span>
              </div>
              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <span className="text-[#71717a] block">Avg Holding:</span>
                <span className="text-sm font-bold text-[#fafafa]">
                  {Math.round(selectedTrader.metrics.avgHoldingTimeSeconds / 60)}m
                </span>
              </div>
            </div>

            {/* Additional Analytics */}
            <div className="grid grid-cols-2 gap-2 mb-4 text-[11px]">
              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <span className="text-[#71717a] block mb-0.5">Largest Winning Trade:</span>
                <span className="font-bold text-[#00FF88]">
                  +{selectedTrader.metrics.largestWinSol} SOL
                </span>
              </div>
              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <span className="text-[#71717a] block mb-0.5">Largest Losing Trade:</span>
                <span className="font-bold text-[#ef4444]">
                  {selectedTrader.metrics.largestLossSol} SOL
                </span>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <a
                href={`https://solscan.io/account/${selectedTrader.address}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#00FF88] text-[#09090b] text-xs font-bold hover:bg-[#00e67a]"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                View Account on Solscan
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
