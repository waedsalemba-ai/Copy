import React, { useState } from 'react';
import {
  Search,
  Filter,
  ExternalLink,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  HelpCircle,
  Repeat,
  ChevronRight,
  Clock,
  Layers,
  X,
  Copy,
  Check,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  ShieldX,
  Loader2,
} from 'lucide-react';
import { CanonicalTradeEvent, TokenRiskAnalysis, TokenRiskLevel } from '../types';

const RISK_STYLES: Record<TokenRiskLevel, { bg: string; text: string; border: string; label: string }> = {
  LOW: { bg: 'bg-[#00FF88]/10', text: 'text-[#00FF88]', border: 'border-[#00FF88]/30', label: 'LOW' },
  MEDIUM: { bg: 'bg-[#eab308]/10', text: 'text-[#eab308]', border: 'border-[#eab308]/30', label: 'MED' },
  HIGH: { bg: 'bg-[#f97316]/10', text: 'text-[#f97316]', border: 'border-[#f97316]/30', label: 'HIGH' },
  CRITICAL: { bg: 'bg-[#ef4444]/15', text: 'text-[#ef4444]', border: 'border-[#ef4444]/40', label: 'CRIT' },
  UNKNOWN: { bg: 'bg-[#71717a]/10', text: 'text-[#71717a]', border: 'border-[#27272a]', label: 'N/A' },
};

const RiskBadge: React.FC<{ risk?: TokenRiskAnalysis }> = ({ risk }) => {
  if (!risk) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#71717a]/10 text-[#71717a] border border-[#27272a]">
        <ShieldQuestion className="w-2.5 h-2.5" />
        N/A
      </span>
    );
  }

  if (risk.pending) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#71717a]/10 text-[#71717a] border border-[#27272a]">
        <Loader2 className="w-2.5 h-2.5 animate-spin" />
        CHECKING
      </span>
    );
  }

  const style = RISK_STYLES[risk.level];
  const Icon = risk.level === 'LOW' ? ShieldCheck : risk.level === 'HIGH' || risk.level === 'CRITICAL' ? ShieldX : ShieldAlert;
  const title = risk.flags.join(' • ');

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold ${style.bg} ${style.text} border ${style.border} cursor-help`}
    >
      <Icon className="w-2.5 h-2.5" />
      {style.label} · {risk.score}
    </span>
  );
};

const VolMcBadge: React.FC<{ risk?: TokenRiskAnalysis }> = ({ risk }) => {
  if (!risk || risk.pending || risk.volumeExceedsMarketCap === undefined) {
    return <span className="text-[9px] text-[#71717a] font-mono">-</span>;
  }

  const isY = risk.volumeExceedsMarketCap;
  const title =
    risk.volume24hUsd !== undefined && risk.marketCapUsd !== undefined
      ? `24h vol $${Math.round(risk.volume24hUsd).toLocaleString()} vs mcap $${Math.round(
          risk.marketCapUsd
        ).toLocaleString()}`
      : undefined;

  return (
    <span
      title={title}
      className={`inline-flex items-center justify-center w-4 h-4 rounded text-[9px] font-bold cursor-help ${
        isY
          ? 'bg-[#eab308]/15 text-[#eab308] border border-[#eab308]/30'
          : 'bg-[#71717a]/10 text-[#71717a] border border-[#27272a]'
      }`}
    >
      {isY ? 'Y' : 'N'}
    </span>
  );
};

interface LiveTradesFeedProps {
  trades: CanonicalTradeEvent[];
  limit?: number;
}

export const LiveTradesFeed: React.FC<LiveTradesFeedProps> = ({ trades, limit }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedAction, setSelectedAction] = useState<string>('ALL');
  const [selectedDex, setSelectedDex] = useState<string>('ALL');
  const [minSol, setMinSol] = useState<number>(0);
  const [selectedTrade, setSelectedTrade] = useState<CanonicalTradeEvent | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  const handleCopy = (text: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
    setCopiedAddress(text);
    setTimeout(() => {
      setCopiedAddress((prev) => (prev === text ? null : prev));
    }, 1800);
  };

  const fallbackCopy = (text: string) => {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    } catch (err) {
      console.error('Fallback copy failed', err);
    }
  };

  // De-duplicate by token: keep only the most recent trade per tokenMint so
  // the stream reads as one row per token rather than repeating it on every
  // trade. `trades` arrives newest-first, so the first occurrence we see
  // for a given mint is already its latest trade.
  const dedupedTrades = React.useMemo(() => {
    const seen = new Set<string>();
    const result: CanonicalTradeEvent[] = [];
    for (const t of trades) {
      if (seen.has(t.tokenMint)) continue;
      seen.add(t.tokenMint);
      result.push(t);
    }
    return result;
  }, [trades]);

  const displayList = limit ? dedupedTrades.slice(0, limit) : dedupedTrades;

  const filteredTrades = displayList.filter((t) => {
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const matchTrader = t.traderName.toLowerCase().includes(q);
      const matchWallet = t.walletAddress.toLowerCase().includes(q);
      const matchToken = t.tokenSymbol.toLowerCase().includes(q) || t.tokenMint.toLowerCase().includes(q);
      const matchSig = t.signature.toLowerCase().includes(q);
      if (!matchTrader && !matchWallet && !matchToken && !matchSig) return false;
    }

    if (selectedAction !== 'ALL' && t.action !== selectedAction) return false;
    if (selectedDex !== 'ALL' && t.dex !== selectedDex) return false;
    if (minSol > 0 && t.solAmount < minSol) return false;

    return true;
  });

  const getActionBadge = (action: string) => {
    switch (action) {
      case 'BUY':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30">
            <ArrowUpRight className="w-3 h-3" />
            BUY
          </span>
        );
      case 'SELL':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-[#ef4444]/15 text-[#ef4444] border border-[#ef4444]/30">
            <ArrowDownRight className="w-3 h-3" />
            SELL
          </span>
        );
      case 'TRANSFER':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-[#3b82f6]/15 text-[#3b82f6] border border-[#3b82f6]/30">
            <Repeat className="w-3 h-3" />
            TRANSFER
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-[#eab308]/15 text-[#eab308] border border-[#eab308]/30">
            <HelpCircle className="w-3 h-3" />
            UNKNOWN
          </span>
        );
    }
  };

  return (
    <div className="bg-[#18181b] border border-[#27272a] rounded p-3 shadow-md">
      {/* Header & Controls */}
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#00FF88] animate-pulse"></div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#fafafa] font-mono">
            LIVE TRADES STREAM
          </h2>
          <span className="text-[10px] text-[#71717a] font-mono">
            ({filteredTrades.length} detected)
          </span>
        </div>

        {/* Filter Toolbar */}
        <div className="flex flex-wrap items-center gap-1.5 w-full lg:w-auto font-mono">
          {/* Search Box */}
          <div className="relative flex-1 sm:flex-none">
            <Search className="w-3 h-3 absolute left-2 top-2 text-[#71717a]" />
            <input
              type="text"
              placeholder="Filter trader, token, sig..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full sm:w-44 pl-7 pr-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[11px] text-[#fafafa] placeholder:text-[#71717a] focus:outline-none focus:border-[#00FF88]"
            />
          </div>

          {/* Action Filter */}
          <select
            value={selectedAction}
            onChange={(e) => setSelectedAction(e.target.value)}
            className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[11px] text-[#fafafa] focus:outline-none focus:border-[#00FF88]"
          >
            <option value="ALL">All Actions</option>
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
            <option value="UNKNOWN">UNKNOWN</option>
            <option value="TRANSFER">TRANSFER</option>
          </select>

          {/* DEX Filter */}
          <select
            value={selectedDex}
            onChange={(e) => setSelectedDex(e.target.value)}
            className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[11px] text-[#fafafa] focus:outline-none focus:border-[#00FF88]"
          >
            <option value="ALL">All DEXs</option>
            <option value="Jupiter">Jupiter</option>
            <option value="Raydium">Raydium</option>
            <option value="Orca">Orca</option>
            <option value="Pump.fun">Pump.fun</option>
            <option value="Meteora">Meteora</option>
          </select>

          {/* Min SOL Filter */}
          <select
            value={minSol}
            onChange={(e) => setMinSol(parseFloat(e.target.value))}
            className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[11px] text-[#fafafa] focus:outline-none focus:border-[#00FF88]"
          >
            <option value={0}>Min SOL: Any</option>
            <option value={0.5}>Min 0.5 SOL</option>
            <option value={1.0}>Min 1.0 SOL</option>
            <option value={5.0}>Min 5.0 SOL</option>
          </select>
        </div>
      </div>

      {/* Trades Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-[11px] font-mono">
          <thead>
            <tr className="border-b border-[#27272a] text-[#71717a] font-bold bg-[#09090b] uppercase tracking-wider text-[10px]">
              <th className="py-2 px-2.5">Time</th>
              <th className="py-2 px-2.5">Trader</th>
              <th className="py-2 px-2.5">Action</th>
              <th className="py-2 px-2.5">Token</th>
              <th className="py-2 px-2.5">Risk</th>
              <th className="py-2 px-2.5 text-center" title="24h volume greater than market cap">Vol&gt;MC</th>
              <th className="py-2 px-2.5 text-right">Amount</th>
              <th className="py-2 px-2.5 text-right">SOL Value</th>
              <th className="py-2 px-2.5 text-right">Price</th>
              <th className="py-2 px-2.5">DEX</th>
              <th className="py-2 px-2.5 text-right">Latency</th>
              <th className="py-2 px-2.5 text-center">Status</th>
              <th className="py-2 px-2.5 text-right">View</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#27272a]/60 text-[#fafafa]">
            {filteredTrades.length === 0 ? (
              <tr>
                <td colSpan={13} className="py-6 text-center text-[#71717a]">
                  No trades match the current filter criteria.
                </td>
              </tr>
            ) : (
              filteredTrades.map((t, index) => {
                const timeStr = new Date(t.timestamp).toLocaleTimeString();
                return (
                  <tr
                    key={`${t.id}_${index}`}
                    className="hover:bg-[#27272a]/40 transition-colors cursor-pointer group"
                    onClick={() => setSelectedTrade(t)}
                  >
                    <td className="py-2 px-2.5 text-[#71717a] whitespace-nowrap">
                      {timeStr}
                    </td>
                    <td className="py-2 px-2.5">
                      <div className="font-bold text-[#fafafa]">{t.traderName}</div>
                      <button
                        type="button"
                        onClick={(e) => handleCopy(t.walletAddress, e)}
                        title={`Copy wallet: ${t.walletAddress}`}
                        className={`group/w inline-flex items-center gap-1 text-[9px] font-mono transition-colors ${
                          copiedAddress === t.walletAddress
                            ? 'text-[#00FF88] font-bold'
                            : 'text-[#71717a] hover:text-[#fafafa]'
                        }`}
                      >
                        <span>
                          {t.walletAddress && t.walletAddress.length > 8
                            ? `${t.walletAddress.slice(0, 4)}...${t.walletAddress.slice(-4)}`
                            : t.walletAddress || '-'}
                        </span>
                        {copiedAddress === t.walletAddress ? (
                          <Check className="w-2.5 h-2.5 text-[#00FF88]" />
                        ) : (
                          <Copy className="w-2.5 h-2.5 opacity-0 group-hover/w:opacity-80 transition-opacity" />
                        )}
                      </button>
                    </td>
                    <td className="py-2 px-2.5">{getActionBadge(t.action)}</td>
                    <td className="py-2 px-2.5">
                      <div className="font-bold text-[#3b82f6]">{t.tokenSymbol}</div>
                      <button
                        type="button"
                        onClick={(e) => handleCopy(t.tokenMint, e)}
                        title={`Click to copy token address: ${t.tokenMint}`}
                        className={`group/mint mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 -ml-1 rounded text-[10px] font-mono transition-all border ${
                          copiedAddress === t.tokenMint
                            ? 'bg-[#00FF88]/15 border-[#00FF88]/40 text-[#00FF88]'
                            : 'bg-[#09090b]/50 border-transparent hover:border-[#27272a] hover:bg-[#27272a]/70 text-[#71717a] hover:text-[#fafafa]'
                        }`}
                      >
                        <span>
                          {t.tokenMint && t.tokenMint.length > 8
                            ? `${t.tokenMint.slice(0, 4)}...${t.tokenMint.slice(-4)}`
                            : t.tokenMint || '-'}
                        </span>
                        {copiedAddress === t.tokenMint ? (
                          <>
                            <Check className="w-2.5 h-2.5 text-[#00FF88]" />
                            <span className="text-[8px] font-bold text-[#00FF88] uppercase tracking-wide">
                              Copied!
                            </span>
                          </>
                        ) : (
                          <Copy className="w-2.5 h-2.5 opacity-70 group-hover/mint:opacity-100 group-hover/mint:text-[#00FF88] transition-all" />
                        )}
                      </button>
                    </td>
                    <td className="py-2 px-2.5">
                      <RiskBadge risk={t.riskAnalysis} />
                    </td>
                    <td className="py-2 px-2.5 text-center">
                      <VolMcBadge risk={t.riskAnalysis} />
                    </td>
                    <td className="py-2 px-2.5 text-right font-medium">
                      {t.tokenAmount
                        ? t.tokenAmount >= 1000
                          ? t.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })
                          : t.tokenAmount.toFixed(4)
                        : '-'}
                    </td>
                    <td className="py-2 px-2.5 text-right font-bold text-[#00FF88]">
                      {t.solAmount > 0 ? `${t.solAmount.toFixed(2)} SOL` : '-'}
                      <div className="text-[9px] text-[#71717a] font-normal">
                        ${t.usdValue.toFixed(0)}
                      </div>
                    </td>
                    <td className="py-2 px-2.5 text-right text-[#a1a1aa]">
                      {t.executionPriceSol > 0
                        ? `${t.executionPriceSol < 0.0001 ? t.executionPriceSol.toExponential(2) : t.executionPriceSol.toFixed(5)}`
                        : '-'}
                    </td>
                    <td className="py-2 px-2.5">
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#09090b] text-[#fafafa] border border-[#27272a]">
                        {t.dex}
                      </span>
                    </td>
                    <td className="py-2 px-2.5 text-right font-bold text-[#00FF88]">
                      {t.detectionLatencyMs}ms
                    </td>
                    <td className="py-2 px-2.5 text-center">
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#00FF88]/10 text-[#00FF88] border border-[#00FF88]/30">
                        VERIFIED
                      </span>
                    </td>
                    <td className="py-2 px-2.5 text-right">
                      <button className="p-1 rounded bg-[#09090b] border border-[#27272a] hover:border-[#00FF88] text-[#71717a] group-hover:text-[#00FF88] transition-colors">
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Detail Modal */}
      {selectedTrade && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#09090b]/90 backdrop-blur-sm">
          <div className="bg-[#18181b] border border-[#27272a] rounded max-w-xl w-full p-5 shadow-2xl relative font-mono">
            <button
              onClick={() => setSelectedTrade(null)}
              className="absolute top-4 right-4 p-1 rounded bg-[#09090b] border border-[#27272a] text-[#71717a] hover:text-[#fafafa]"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-2 mb-4">
              {getActionBadge(selectedTrade.action)}
              <h3 className="text-sm font-bold text-[#fafafa] uppercase">
                Canonical Trade Inspection
              </h3>
            </div>

            <div className="grid grid-cols-2 gap-2 mb-4 text-[11px]">
              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <div className="flex items-center justify-between">
                  <span className="text-[#71717a]">Trader:</span>
                  <button
                    type="button"
                    onClick={(e) => handleCopy(selectedTrade.walletAddress, e)}
                    className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded bg-[#18181b] border border-[#27272a] hover:border-[#00FF88]/40 text-[#71717a] hover:text-[#fafafa] transition-colors"
                    title="Copy wallet address"
                  >
                    {copiedAddress === selectedTrade.walletAddress ? (
                      <>
                        <Check className="w-2.5 h-2.5 text-[#00FF88]" />
                        <span className="text-[#00FF88] font-bold">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-2.5 h-2.5" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="font-bold text-[#fafafa] mt-0.5">{selectedTrade.traderName}</p>
                <span className="text-[9px] text-[#71717a] font-mono break-all">{selectedTrade.walletAddress}</span>
              </div>

              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <div className="flex items-center justify-between">
                  <span className="text-[#71717a]">Token:</span>
                  <button
                    type="button"
                    onClick={(e) => handleCopy(selectedTrade.tokenMint, e)}
                    className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded bg-[#18181b] border border-[#27272a] hover:border-[#00FF88]/40 text-[#71717a] hover:text-[#fafafa] transition-colors"
                    title="Copy token mint address"
                  >
                    {copiedAddress === selectedTrade.tokenMint ? (
                      <>
                        <Check className="w-2.5 h-2.5 text-[#00FF88]" />
                        <span className="text-[#00FF88] font-bold">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-2.5 h-2.5" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="font-bold text-[#3b82f6] mt-0.5">{selectedTrade.tokenSymbol}</p>
                <span className="text-[9px] text-[#a1a1aa] font-mono break-all block mt-0.5">{selectedTrade.tokenMint}</span>
              </div>

              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <span className="text-[#71717a]">SOL Value:</span>
                <p className="font-bold text-[#00FF88]">
                  {selectedTrade.solAmount} SOL (${selectedTrade.usdValue.toFixed(2)})
                </p>
              </div>

              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <span className="text-[#71717a]">Detection Latency:</span>
                <p className="font-bold text-[#00FF88]">{selectedTrade.detectionLatencyMs} ms</p>
              </div>

              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <span className="text-[#71717a]">DEX Protocol:</span>
                <p className="font-bold text-[#fafafa]">{selectedTrade.dex}</p>
              </div>

              <div className="p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <span className="text-[#71717a]">Slot & Confidence:</span>
                <p className="font-bold text-[#fafafa]">
                  Slot {selectedTrade.slot} ({(selectedTrade.confidence * 100).toFixed(0)}% conf)
                </p>
              </div>
            </div>

            {selectedTrade.riskAnalysis && (
              <div className="mb-4 p-2.5 rounded bg-[#09090b] border border-[#27272a]">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-[#71717a] uppercase tracking-wide">Rug Risk Analysis</span>
                  <RiskBadge risk={selectedTrade.riskAnalysis} />
                </div>
                {selectedTrade.riskAnalysis.pending ? (
                  <p className="text-[10px] text-[#71717a]">Analyzing token on-chain data & liquidity…</p>
                ) : (
                  <>
                    <ul className="space-y-1 mb-2">
                      {selectedTrade.riskAnalysis.flags.map((f, i) => (
                        <li key={i} className="text-[10px] text-[#a1a1aa] flex gap-1.5">
                          <span className="text-[#71717a]">•</span>
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="grid grid-cols-2 gap-1.5 text-[9px] text-[#71717a]">
                      {selectedTrade.riskAnalysis.liquidityUsd !== undefined && (
                        <span>Liquidity: ${Math.round(selectedTrade.riskAnalysis.liquidityUsd).toLocaleString()}</span>
                      )}
                      {selectedTrade.riskAnalysis.ageMinutes !== undefined && (
                        <span>
                          Pool age:{' '}
                          {selectedTrade.riskAnalysis.ageMinutes < 60
                            ? `${Math.round(selectedTrade.riskAnalysis.ageMinutes)}m`
                            : `${(selectedTrade.riskAnalysis.ageMinutes / 60).toFixed(1)}h`}
                        </span>
                      )}
                      {selectedTrade.riskAnalysis.mintAuthorityRevoked !== undefined && (
                        <span>Mint authority: {selectedTrade.riskAnalysis.mintAuthorityRevoked ? 'revoked ✓' : 'active ⚠'}</span>
                      )}
                      {selectedTrade.riskAnalysis.freezeAuthorityRevoked !== undefined && (
                        <span>Freeze authority: {selectedTrade.riskAnalysis.freezeAuthorityRevoked ? 'revoked ✓' : 'active ⚠'}</span>
                      )}
                      {selectedTrade.riskAnalysis.topHolderPercent !== undefined && (
                        <span>Top holder: {selectedTrade.riskAnalysis.topHolderPercent.toFixed(1)}%</span>
                      )}
                      {selectedTrade.riskAnalysis.volume24hUsd !== undefined && (
                        <span>24h Vol: ${Math.round(selectedTrade.riskAnalysis.volume24hUsd).toLocaleString()}</span>
                      )}
                      {selectedTrade.riskAnalysis.marketCapUsd !== undefined && (
                        <span>Market Cap: ${Math.round(selectedTrade.riskAnalysis.marketCapUsd).toLocaleString()}</span>
                      )}
                      {selectedTrade.riskAnalysis.volumeExceedsMarketCap !== undefined && (
                        <span>
                          Vol &gt; MCap:{' '}
                          <span className={selectedTrade.riskAnalysis.volumeExceedsMarketCap ? 'text-[#eab308] font-bold' : ''}>
                            {selectedTrade.riskAnalysis.volumeExceedsMarketCap ? 'Y' : 'N'}
                          </span>
                        </span>
                      )}
                    </div>
                    <p className="text-[8px] text-[#52525b] mt-2">
                      Heuristic read from public data only — not financial advice, always DYOR.
                    </p>
                  </>
                )}
              </div>
            )}

            <div className="mb-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-[#71717a]">Solana Signature:</span>
                <button
                  type="button"
                  onClick={(e) => handleCopy(selectedTrade.signature, e)}
                  className="inline-flex items-center gap-1 text-[9px] text-[#71717a] hover:text-[#fafafa]"
                >
                  {copiedAddress === selectedTrade.signature ? (
                    <>
                      <Check className="w-2.5 h-2.5 text-[#00FF88]" />
                      <span className="text-[#00FF88] font-bold">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-2.5 h-2.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <div className="p-2 rounded bg-[#09090b] border border-[#27272a] text-[10px] text-[#00FF88] break-all select-all font-mono">
                {selectedTrade.signature}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <a
                href={`https://solscan.io/tx/${selectedTrade.signature}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#00FF88] text-[#09090b] font-bold text-xs hover:bg-[#00e67a] transition-all"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                View on Solscan
              </a>
            </div>
          </div>
        </div>
      )}
      {/* Copied toast notification */}
      {copiedAddress && (
        <div className="fixed bottom-5 right-5 z-50 px-3 py-1.5 rounded bg-[#18181b] border border-[#00FF88]/50 text-[#00FF88] font-mono text-xs shadow-2xl flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-[#00FF88]" />
          <span>Address copied to clipboard</span>
        </div>
      )}
    </div>
  );
};
