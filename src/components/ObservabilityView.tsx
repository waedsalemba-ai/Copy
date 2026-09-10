import React from 'react';
import { Cpu } from 'lucide-react';
import { SystemMetrics } from '../types';

interface ObservabilityViewProps {
  metrics: SystemMetrics;
  onTestRpc: () => void;
  onTestLaserstream: () => void;
}

export const ObservabilityView: React.FC<ObservabilityViewProps> = ({
  metrics,
  onTestRpc,
  onTestLaserstream,
}) => {
  return (
    <div className="space-y-3 font-mono text-xs">
      {/* Header */}
      <div className="bg-[#18181b] border border-[#27272a] rounded p-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#fafafa] flex items-center gap-2">
            <Cpu className="w-4 h-4 text-[#00FF88]" />
            SYSTEM OBSERVABILITY & DIAGNOSTIC PANEL
          </h2>
          <p className="text-[10px] text-[#71717a] mt-0.5">
            Real-time pipeline diagnostics, latency benchmarks, and connectivity monitors.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onTestRpc}
            className="px-2.5 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[11px] transition-colors"
          >
            Ping RPC
          </button>
          <button
            onClick={onTestLaserstream}
            className="px-2.5 py-1 rounded bg-[#00FF88] text-[#09090b] font-bold text-[11px] hover:bg-[#00e67a] transition-colors"
          >
            Ping LaserStream
          </button>
        </div>
      </div>

      {/* Connection Gauges */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* LaserStream Connection */}
        <div className="bg-[#18181b] border border-[#27272a] rounded p-3">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[#71717a] font-bold uppercase text-[10px]">LaserStream Pipeline</span>
            <span
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                metrics.laserstreamConnected
                  ? 'bg-[#00FF88]/15 text-[#00FF88] border-[#00FF88]/30'
                  : 'bg-[#ef4444]/15 text-[#ef4444] border-[#ef4444]/30'
              }`}
            >
              {metrics.laserstreamConnected ? 'STREAMING ACTIVE' : 'DISCONNECTED'}
            </span>
          </div>

          <div className="space-y-1.5 text-[11px] text-[#fafafa]">
            <div className="flex justify-between py-1 border-b border-[#27272a]/60">
              <span className="text-[#71717a]">Endpoint:</span>
              <span className="text-[#fafafa] truncate max-w-[220px]">
                {metrics.laserstreamEndpoint}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-[#27272a]/60">
              <span className="text-[#71717a]">Current Slot:</span>
              <span className="text-[#00FF88] font-bold">{metrics.lastSlot}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-[#71717a]">Reconnect Count:</span>
              <span className="text-[#fafafa] font-bold">{metrics.reconnectCount}</span>
            </div>
          </div>
        </div>

        {/* RPC Health */}
        <div className="bg-[#18181b] border border-[#27272a] rounded p-3">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[#71717a] font-bold uppercase text-[10px]">Solana RPC Verification</span>
            <span
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                metrics.rpcConnected
                  ? 'bg-[#00FF88]/15 text-[#00FF88] border-[#00FF88]/30'
                  : 'bg-[#ef4444]/15 text-[#ef4444] border-[#ef4444]/30'
              }`}
            >
              {metrics.rpcConnected ? 'HEALTHY' : 'DEGRADED'}
            </span>
          </div>

          <div className="space-y-1.5 text-[11px] text-[#fafafa]">
            <div className="flex justify-between py-1 border-b border-[#27272a]/60">
              <span className="text-[#71717a]">RPC Latency:</span>
              <span className="text-[#00FF88] font-bold">{metrics.rpcLatencyMs} ms</span>
            </div>
            <div className="flex justify-between py-1 border-b border-[#27272a]/60">
              <span className="text-[#71717a]">RPC Errors:</span>
              <span className="text-[#ef4444] font-bold">{metrics.rpcErrors}</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-[#71717a]">WS Clients Connected:</span>
              <span className="text-[#3b82f6] font-bold">{metrics.wsClientCount}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Metrics Counters Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="p-2.5 rounded bg-[#18181b] border border-[#27272a]">
          <span className="text-[#71717a] block text-[10px]">Total Processed:</span>
          <span className="text-sm font-bold text-[#fafafa]">
            {metrics.totalTransactionsProcessed}
          </span>
        </div>

        <div className="p-2.5 rounded bg-[#18181b] border border-[#27272a]">
          <span className="text-[#71717a] block text-[10px]">Trades Detected:</span>
          <span className="text-sm font-bold text-[#00FF88]">
            {metrics.totalTradesDetected}
          </span>
        </div>

        <div className="p-2.5 rounded bg-[#18181b] border border-[#27272a]">
          <span className="text-[#71717a] block text-[10px]">Duplicate Filtered:</span>
          <span className="text-sm font-bold text-[#fafafa]">{metrics.duplicateCount}</span>
        </div>

        <div className="p-2.5 rounded bg-[#18181b] border border-[#27272a]">
          <span className="text-[#71717a] block text-[10px]">Avg Ingestion Latency:</span>
          <span className="text-sm font-bold text-[#00FF88]">
            {metrics.avgDetectionLatencyMs} ms
          </span>
        </div>
      </div>
    </div>
  );
};
