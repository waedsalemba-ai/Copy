import React, { useState } from 'react';
import { PieChart } from 'lucide-react';
import { Position } from '../types';
import { formatAddress, formatSol, formatTokenQuantity } from '../utils/formatters';

interface PositionsViewProps {
  positions: Position[];
}

export const PositionsView: React.FC<PositionsViewProps> = ({ positions }) => {
  const [activeTab, setActiveTab] = useState<'OPEN' | 'CLOSED' | 'ALL'>('OPEN');
  const [searchTerm, setSearchTerm] = useState('');

  const filteredPositions = positions.filter((p) => {
    if (activeTab !== 'ALL' && p.status !== activeTab) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const matchToken = p.tokenSymbol.toLowerCase().includes(q) || p.tokenMint.toLowerCase().includes(q);
      const matchTrader = p.traderName.toLowerCase().includes(q) || p.walletAddress.toLowerCase().includes(q);
      if (!matchToken && !matchTrader) return false;
    }
    return true;
  });

  const openPositions = positions.filter((p) => p.status === 'OPEN');
  const closedPositions = positions.filter((p) => p.status === 'CLOSED');

  return (
    <div className="bg-[#18181b] border border-[#27272a] rounded p-3 shadow-md space-y-3 font-mono">
      {/* Header & Tabs */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#fafafa] font-mono flex items-center gap-2">
            <PieChart className="w-4 h-4 text-[#3b82f6]" />
            POSITION ENGINE DASHBOARD
          </h2>
          <p className="text-[10px] text-[#71717a]">
            Real-time average entry price, total cost, remaining cost basis, and P&L tracking.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center bg-[#09090b] border border-[#27272a] rounded p-0.5 text-[11px]">
            <button
              onClick={() => setActiveTab('OPEN')}
              className={`px-2.5 py-0.5 rounded transition-all font-bold ${
                activeTab === 'OPEN'
                  ? 'bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30'
                  : 'text-[#71717a] hover:text-[#fafafa]'
              }`}
            >
              OPEN ({openPositions.length})
            </button>
            <button
              onClick={() => setActiveTab('CLOSED')}
              className={`px-2.5 py-0.5 rounded transition-all font-bold ${
                activeTab === 'CLOSED'
                  ? 'bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30'
                  : 'text-[#71717a] hover:text-[#fafafa]'
              }`}
            >
              CLOSED ({closedPositions.length})
            </button>
            <button
              onClick={() => setActiveTab('ALL')}
              className={`px-2.5 py-0.5 rounded transition-all font-bold ${
                activeTab === 'ALL'
                  ? 'bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30'
                  : 'text-[#71717a] hover:text-[#fafafa]'
              }`}
            >
              ALL ({positions.length})
            </button>
          </div>
        </div>
      </div>

      {/* Positions Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-[11px] font-mono">
          <thead>
            <tr className="border-b border-[#27272a] text-[#71717a] font-bold bg-[#09090b] uppercase tracking-wider text-[10px]">
              <th className="py-2 px-2.5">Token</th>
              <th className="py-2 px-2.5">Trader</th>
              <th className="py-2 px-2.5 text-right">Quantity</th>
              <th className="py-2 px-2.5 text-right">Avg Entry</th>
              <th className="py-2 px-2.5 text-right">Current Price</th>
              <th className="py-2 px-2.5 text-right">Cost Basis</th>
              <th className="py-2 px-2.5 text-right">Realized P&L</th>
              <th className="py-2 px-2.5 text-right">Unrealized P&L</th>
              <th className="py-2 px-2.5 text-center">Buys / Sells</th>
              <th className="py-2 px-2.5 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#27272a]/60 text-[#fafafa]">
            {filteredPositions.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-6 text-center text-[#71717a]">
                  No positions match the selected view mode.
                </td>
              </tr>
            ) : (
              filteredPositions.map((p, idx) => {
                return (
                  <tr key={`${p.id}_${idx}`} className="hover:bg-[#27272a]/40 transition-colors">
                    <td className="py-2 px-2.5">
                      <div className="font-bold text-[#3b82f6]">{p.tokenSymbol}</div>
                      <div className="text-[9px] text-[#71717a]">
                        {formatAddress(p.tokenMint)}
                      </div>
                    </td>
                    <td className="py-2 px-2.5">
                      <div className="font-bold text-[#fafafa]">{p.traderName}</div>
                      <div className="text-[9px] text-[#71717a]">
                        {formatAddress(p.walletAddress)}
                      </div>
                    </td>
                    <td className="py-2 px-2.5 text-right font-medium">
                      {formatTokenQuantity(p.currentQuantity)}
                    </td>
                    <td className="py-2 px-2.5 text-right text-[#a1a1aa]">
                      {formatSol(p.averageEntryPriceSol, 5)}
                    </td>
                    <td className="py-2 px-2.5 text-right font-bold text-[#fafafa]">
                      {formatSol(p.currentPriceSol, 5)}
                    </td>
                    <td className="py-2 px-2.5 text-right text-[#00FF88]">
                      {formatSol(p.remainingCostBasisSol, 2)}
                    </td>
                    <td
                      className={`py-2 px-2.5 text-right font-bold ${
                        p.realizedPnlSol >= 0 ? 'text-[#00FF88]' : 'text-[#ef4444]'
                      }`}
                    >
                      {formatSol(p.realizedPnlSol, 2, true)}
                    </td>
                    <td
                      className={`py-2 px-2.5 text-right font-bold ${
                        p.unrealizedPnlSol >= 0 ? 'text-[#00FF88]' : 'text-[#ef4444]'
                      }`}
                    >
                      {p.status === 'OPEN' ? (
                        formatSol(p.unrealizedPnlSol, 2, true)
                      ) : (
                        <span className="text-[#71717a]">-</span>
                      )}
                    </td>
                    <td className="py-2 px-2.5 text-center">
                      <span className="px-1.5 py-0.5 rounded bg-[#09090b] text-[#fafafa] font-bold text-[9px] border border-[#27272a]">
                        {p.buyCount}B / {p.sellCount}S
                      </span>
                    </td>
                    <td className="py-2 px-2.5 text-center">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                          p.status === 'OPEN'
                            ? 'bg-[#00FF88]/15 text-[#00FF88] border-[#00FF88]/30'
                            : 'bg-[#09090b] text-[#71717a] border-[#27272a]'
                        }`}
                      >
                        {p.status}
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
  );
};
