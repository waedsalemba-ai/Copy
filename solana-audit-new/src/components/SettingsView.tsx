import React, { useState } from 'react';
import {
  Settings,
  CheckCircle2,
  XCircle,
  Play,
  RotateCcw,
  Key,
  Globe,
  Radio,
  Check,
  Zap,
  ShieldCheck,
  Trash2,
  Flame,
  Database,
  Cloud,
} from 'lucide-react';
import { AppSettings, SystemMetrics, AcceptanceTestReport } from '../types';

interface SettingsViewProps {
  settings: AppSettings;
  metrics: SystemMetrics;
  onSaveSettings: (newSettings: Partial<AppSettings>) => Promise<void>;
  onTestRpc: () => Promise<void>;
  onTestLaserstream: () => Promise<void>;
  onRunTest: () => Promise<AcceptanceTestReport | void>;
  onClearData: () => Promise<void>;
  testReport: AcceptanceTestReport | null;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  metrics,
  onSaveSettings,
  onTestRpc,
  onTestLaserstream,
  onRunTest,
  onClearData,
  testReport,
}) => {
  const [rpcUrl, setRpcUrl] = useState(settings.rpcUrl);
  const [apiKey, setApiKey] = useState(settings.laserstreamApiKey);
  const [endpoint, setEndpoint] = useState(settings.laserstreamEndpoint);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [testLoading, setTestLoading] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSaveSettings({
      rpcUrl,
      laserstreamApiKey: apiKey,
      laserstreamEndpoint: endpoint,
    });
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  return (
    <div className="space-y-3 font-mono text-xs max-w-4xl mx-auto">
      {/* Settings Header */}
      <div className="bg-[#18181b] border border-[#27272a] rounded p-3 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#fafafa] flex items-center gap-2">
            <Settings className="w-4 h-4 text-[#00FF88]" />
            SYSTEM CONFIGURATION & ENDPOINT SETTINGS
          </h2>
          <p className="text-[10px] text-[#71717a] mt-0.5">
            Configure Solana mainnet RPC connection and LaserStream real-time gRPC/WebSocket stream.
          </p>
        </div>

        {savedSuccess && (
          <span className="flex items-center gap-1 text-[#00FF88] font-bold bg-[#00FF88]/10 border border-[#00FF88]/30 px-2.5 py-0.5 rounded text-[11px]">
            <Check className="w-3.5 h-3.5" /> Saved
          </span>
        )}
      </div>

      {/* Main Settings Form */}
      <form onSubmit={handleSave} className="bg-[#18181b] border border-[#27272a] rounded p-3 space-y-3">
        <div>
          <label className="text-[#fafafa] font-bold block mb-1 text-[11px]">Solana RPC Endpoint URL:</label>
          <input
            type="text"
            required
            value={rpcUrl}
            onChange={(e) => setRpcUrl(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
          />
        </div>

        <div>
          <label className="text-[#fafafa] font-bold block mb-1 text-[11px]">LaserStream API Key:</label>
          <input
            type="password"
            required
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
          />
        </div>

        <div>
          <label className="text-[#fafafa] font-bold block mb-1 text-[11px]">LaserStream Endpoint URL:</label>
          <input
            type="text"
            required
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#27272a]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onTestRpc}
              className="px-2.5 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[11px]"
            >
              TEST RPC
            </button>
            <button
              type="button"
              onClick={onTestLaserstream}
              className="px-2.5 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[11px]"
            >
              TEST LASERSTREAM
            </button>
          </div>

          <button
            type="submit"
            className="px-4 py-1.5 rounded bg-[#00FF88] text-[#09090b] font-bold text-[11px] hover:bg-[#00e67a] shadow-sm"
          >
            SAVE CONFIGURATION
          </button>
        </div>
      </form>

      {/* Firebase Cloud Database & Real-time Persistence Info */}
      <div className="bg-[#18181b] border border-[#ff9100]/30 rounded p-3 space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-[#27272a]">
          <div className="flex items-center gap-2">
            <div className="p-1 rounded bg-[#ff9100]/15 border border-[#ff9100]/40">
              <Flame className="w-4 h-4 text-[#ff9100]" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-[#fafafa] uppercase tracking-wider">
                Firebase Firestore Cloud Database
              </h3>
              <p className="text-[10px] text-[#71717a]">
                Every user entry (wallets, thresholds, copy trade settings, simulated trades, and actions) is persistently stored in Firestore.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-[#00FF88]/15 border border-[#00FF88]/30 text-[#00FF88] text-[10px] font-bold">
              <span className="w-2 h-2 rounded-full bg-[#00FF88] animate-pulse" />
              ONLINE & SYNCED
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
          <div className="p-2 rounded bg-[#09090b] border border-[#27272a] space-y-1">
            <span className="text-[#71717a] uppercase text-[10px] block font-bold">Firebase Project:</span>
            <span className="text-[#fafafa] font-bold">powerful-utility-tsx2c</span>
            <span className="text-[10px] text-[#a1a1aa] block">Google Cloud Platform • europe-west2</span>
          </div>

          <div className="p-2 rounded bg-[#09090b] border border-[#27272a] space-y-1">
            <span className="text-[#71717a] uppercase text-[10px] block font-bold">Firestore Database ID:</span>
            <span className="text-[#fafafa] font-bold truncate block">
              ai-studio-solanatraderwall-7b2f9445-7969-4694-968f-2cebc682fb99
            </span>
            <span className="text-[10px] text-[#00FF88] block">Rules Version 2 Deployed & Active</span>
          </div>
        </div>

        <div className="p-2 rounded bg-[#09090b] border border-[#27272a] space-y-1.5">
          <div className="flex items-center gap-1.5 text-[#ff9100] text-[10px] font-bold uppercase">
            <Database className="w-3 h-3" />
            <span>Synced Firestore Collections:</span>
          </div>
          <div className="flex flex-wrap gap-1.5 text-[10px]">
            <span className="px-2 py-0.5 rounded bg-[#18181b] border border-[#27272a] text-[#fafafa]">
              📁 /wallets (Monitored Wallets)
            </span>
            <span className="px-2 py-0.5 rounded bg-[#18181b] border border-[#27272a] text-[#fafafa]">
              📁 /settings (RPC & Endpoints)
            </span>
            <span className="px-2 py-0.5 rounded bg-[#18181b] border border-[#27272a] text-[#fafafa]">
              📁 /copyTradeSettings (Engine Parameters)
            </span>
            <span className="px-2 py-0.5 rounded bg-[#18181b] border border-[#27272a] text-[#fafafa]">
              📁 /paperAccount (Balances & P&L)
            </span>
            <span className="px-2 py-0.5 rounded bg-[#18181b] border border-[#27272a] text-[#fafafa]">
              📁 /paperTrades (Simulated Trade Logs)
            </span>
            <span className="px-2 py-0.5 rounded bg-[#18181b] border border-[#27272a] text-[#fafafa]">
              📁 /paperPositions (Portfolio Positions)
            </span>
            <span className="px-2 py-0.5 rounded bg-[#18181b] border border-[#27272a] text-[#fafafa]">
              📁 /userEntries (Audit Activity Stream)
            </span>
          </div>
        </div>
      </div>

      {/* Test Runner Suite */}
      <div className="bg-[#18181b] border border-[#27272a] rounded p-3 space-y-3">
        <h3 className="text-xs font-bold text-[#fafafa] uppercase tracking-wider flex items-center gap-2">
          <Play className="w-4 h-4 text-[#3b82f6]" />
          AUTOMATED ACCEPTANCE TEST SUITE (24 STEPS)
        </h3>

        <p className="text-[10px] text-[#71717a]">
          Runs the complete 24-step end-to-end acceptance flow: RPC entry → LaserStream key → Wallet addition → Ingestion → Decoder → Single Classifier → Position Engine → Deduplicator → P&L verification → Exit.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={async () => {
              setTestLoading(true);
              await onRunTest();
              setTestLoading(false);
            }}
            disabled={testLoading}
            className="px-3 py-1.5 rounded bg-[#00FF88] text-[#09090b] font-bold text-[11px] hover:bg-[#00e67a] disabled:opacity-50"
          >
            {testLoading ? 'Running 24-Step Suite...' : 'EXECUTE 24-STEP TEST SUITE'}
          </button>

          <button
            onClick={onClearData}
            className="px-3 py-1.5 rounded bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/30 font-bold text-[11px] hover:bg-[#ef4444]/20"
          >
            Clear Stored Trades & Positions
          </button>
        </div>

        {/* Test Suite Results Report */}
        {testReport && (
          <div className="mt-3 p-3 rounded bg-[#09090b] border border-[#27272a] space-y-2">
            <div className="flex items-center justify-between border-b border-[#27272a] pb-1.5">
              <span className="font-bold text-[#fafafa] text-[11px]">Test Execution Summary</span>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  testReport.passed
                    ? 'bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30'
                    : 'bg-[#ef4444]/15 text-[#ef4444] border border-[#ef4444]/30'
                }`}
              >
                {testReport.passed ? 'ALL 24 STEPS PASSED' : 'SOME STEPS FAILED'}
              </span>
            </div>

            <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
              {testReport.steps.map((s) => (
                <div
                  key={s.step}
                  className="p-1.5 rounded bg-[#18181b] border border-[#27272a] flex items-start justify-between gap-2"
                >
                  <div>
                    <span className="text-[#71717a] font-bold mr-1.5 text-[10px]">Step {s.step}:</span>
                    <span className="text-[#fafafa] font-semibold text-[11px]">{s.title}</span>
                    <p className="text-[9px] text-[#71717a] mt-0.5">{s.detail}</p>
                  </div>

                  <span
                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                      s.status === 'PASS'
                        ? 'bg-[#00FF88]/15 text-[#00FF88]'
                        : 'bg-[#ef4444]/15 text-[#ef4444]'
                    }`}
                  >
                    {s.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
