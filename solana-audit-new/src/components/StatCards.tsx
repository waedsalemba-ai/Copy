import React from 'react';
import {
  Users,
  PieChart,
  ArrowUpRight,
  ArrowDownRight,
  DollarSign,
  Activity,
  Zap,
} from 'lucide-react';
import { SystemMetrics, Position } from '../types';

interface StatCardsProps {
  metrics: SystemMetrics;
  positions: Position[];
}

export const StatCards: React.FC<StatCardsProps> = ({ metrics, positions }) => {
  const activePositions = positions.filter((p) => p.status === 'OPEN');

  const totalRealizedPnl = positions.reduce((acc, p) => acc + p.realizedPnlSol, 0);
  const totalUnrealizedPnl = activePositions.reduce((acc, p) => acc + p.unrealizedPnlSol, 0);

  const stats = [
    {
      title: 'WALLETS',
      value: metrics.activeWalletsCount,
      subText: 'Active streams',
      icon: Users,
      color: 'text-[#3b82f6]',
      bgColor: 'bg-[#3b82f6]/10',
      borderColor: 'border-[#27272a]',
    },
    {
      title: 'POSITIONS',
      value: activePositions.length,
      subText: `${positions.length} tracked`,
      icon: PieChart,
      color: 'text-[#fafafa]',
      bgColor: 'bg-[#fafafa]/10',
      borderColor: 'border-[#27272a]',
    },
    {
      title: 'BUYS',
      value: metrics.buyCount,
      subText: 'Canonical buys',
      icon: ArrowUpRight,
      color: 'text-[#00FF88]',
      bgColor: 'bg-[#00FF88]/10',
      borderColor: 'border-[#27272a]',
    },
    {
      title: 'SELLS',
      value: metrics.sellCount,
      subText: 'Canonical sells',
      icon: ArrowDownRight,
      color: 'text-[#ef4444]',
      bgColor: 'bg-[#ef4444]/10',
      borderColor: 'border-[#27272a]',
    },
    {
      title: 'REALIZED P&L',
      value: `${totalRealizedPnl >= 0 ? '+' : ''}${totalRealizedPnl.toFixed(2)} SOL`,
      subText: `~$${(totalRealizedPnl * 145.5).toFixed(0)} USD`,
      icon: DollarSign,
      color: totalRealizedPnl >= 0 ? 'text-[#00FF88]' : 'text-[#ef4444]',
      bgColor: totalRealizedPnl >= 0 ? 'bg-[#00FF88]/10' : 'bg-[#ef4444]/10',
      borderColor: 'border-[#27272a]',
    },
    {
      title: 'UNREALIZED P&L',
      value: `${totalUnrealizedPnl >= 0 ? '+' : ''}${totalUnrealizedPnl.toFixed(2)} SOL`,
      subText: `~$${(totalUnrealizedPnl * 145.5).toFixed(0)} USD`,
      icon: DollarSign,
      color: totalUnrealizedPnl >= 0 ? 'text-[#00FF88]' : 'text-[#ef4444]',
      bgColor: totalUnrealizedPnl >= 0 ? 'bg-[#00FF88]/10' : 'bg-[#ef4444]/10',
      borderColor: 'border-[#27272a]',
    },
    {
      title: 'STREAM STATUS',
      value: metrics.laserstreamConnected ? 'CONNECTED' : 'OFFLINE',
      subText: `RPC: ${metrics.rpcConnected ? 'ONLINE' : 'DEGRADED'}`,
      icon: Activity,
      color: metrics.laserstreamConnected ? 'text-[#00FF88]' : 'text-[#ef4444]',
      bgColor: metrics.laserstreamConnected ? 'bg-[#00FF88]/10' : 'bg-[#ef4444]/10',
      borderColor: 'border-[#27272a]',
    },
    {
      title: 'LATENCY',
      value: `${metrics.avgDetectionLatencyMs}ms`,
      subText: `Max: ${metrics.maxDetectionLatencyMs}ms`,
      icon: Zap,
      color: 'text-[#00FF88]',
      bgColor: 'bg-[#00FF88]/10',
      borderColor: 'border-[#27272a]',
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 my-2 font-mono">
      {stats.map((stat, i) => {
        const Icon = stat.icon;
        return (
          <div
            key={i}
            className="p-2.5 rounded bg-[#18181b] border border-[#27272a] flex flex-col justify-between hover:border-[#00FF88]/40 transition-all"
          >
            <div className="flex items-center justify-between gap-1 mb-1">
              <span className="text-[10px] font-bold tracking-wider text-[#71717a] uppercase truncate">
                {stat.title}
              </span>
              <div className={`p-1 rounded ${stat.bgColor} ${stat.color}`}>
                <Icon className="w-3 h-3" />
              </div>
            </div>
            <div>
              <div className={`text-xs font-bold font-mono tracking-tight ${stat.color} truncate`}>
                {stat.value}
              </div>
              <div className="text-[9px] text-[#71717a] mt-0.5 truncate">
                {stat.subText}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
