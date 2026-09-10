import React, { useState } from 'react';
import {
  Settings,
  Play,
  Key,
  Check,
  Flame,
  Database,
  Radio,
  Server,
  Zap,
  Globe,
  Lock,
  Activity,
  AlertCircle,
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

interface TestResult {
  status: 'idle' | 'testing' | 'ok' | 'fail';
  latencyMs?: number;
  message?: string;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  metrics,
  onSaveSettings,
  onRunTest,
  onClearData,
  testReport,
}) => {
  // Endpoints state
  const [primaryRpcUrl, setPrimaryRpcUrl] = useState(
    settings.primaryRpcUrl || settings.rpcUrl || 'https://api.mainnet-beta.solana.com'
  );
  const [secondaryRpcUrl, setSecondaryRpcUrl] = useState(
    settings.secondaryRpcUrl || 'https://solana-mainnet.g.alchemy.com/v2/demo'
  );
  const [primaryLaserstream, setPrimaryLaserstream] = useState(
    settings.primaryLaserstreamEndpoint || settings.laserstreamEndpoint || 'wss://laserstream.solana.com/v1/stream'
  );
  const [secondaryLaserstream, setSecondaryLaserstream] = useState(
    settings.secondaryLaserstreamEndpoint || 'wss://secondary-stream.solana.com/v1'
  );
  const [solanaWssUrl, setSolanaWssUrl] = useState(
    settings.solanaWssUrl || 'wss://api.mainnet-beta.solana.com'
  );

  // Isolated API Keys state
  const [liveApiKey, setLiveApiKey] = useState(settings.liveApiKey || settings.laserstreamApiKey || '');
  const [paperApiKey, setPaperApiKey] = useState(settings.paperApiKey || '');
  const [jupiterApiKey, setJupiterApiKey] = useState(settings.jupiterApiKey || '');
  const [jupiterKeyError, setJupiterKeyError] = useState('');

  // Webhook & Thresholds
  const [webhookUrl, setWebhookUrl] = useState(settings.webhookUrl || '');
  const [minTradeAlertValueUsd, setMinTradeAlertValueUsd] = useState(settings.minTradeAlertValueUsd || 10);

  // UI state
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [testLoading, setTestLoading] = useState(false);

  // Granular Independent Test Results
  const [liveApiTest, setLiveApiTest] = useState<TestResult>({ status: 'idle' });
  const [paperApiTest, setPaperApiTest] = useState<TestResult>({ status: 'idle' });
  const [primaryRpcTest, setPrimaryRpcTest] = useState<TestResult>({ status: 'idle' });
  const [secondaryRpcTest, setSecondaryRpcTest] = useState<TestResult>({ status: 'idle' });
  const [primaryLsTest, setPrimaryLsTest] = useState<TestResult>({ status: 'idle' });
  const [secondaryLsTest, setSecondaryLsTest] = useState<TestResult>({ status: 'idle' });
  const [jupiterTest, setJupiterTest] = useState<TestResult>({ status: 'idle' });
  const [wssTest, setWssTest] = useState<TestResult>({ status: 'idle' });

  const maskString = (val: string) => {
    if (!val || val.length <= 8) return val;
    return `${val.slice(0, 4)}...****`;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedJup = jupiterApiKey.trim();
    if (trimmedJup !== '' && !trimmedJup.toUpperCase().startsWith('JUP')) {
      setJupiterKeyError('Jupiter API key must start with "JUP"');
      return;
    }
    setJupiterKeyError('');

    await onSaveSettings({
      rpcUrl: primaryRpcUrl,
      primaryRpcUrl,
      secondaryRpcUrl,
      laserstreamEndpoint: primaryLaserstream,
      primaryLaserstreamEndpoint: primaryLaserstream,
      secondaryLaserstreamEndpoint: secondaryLaserstream,
      solanaWssUrl,
      liveApiKey,
      laserstreamApiKey: liveApiKey,
      paperApiKey,
      jupiterApiKey: trimmedJup,
      webhookUrl: webhookUrl.trim(),
      minTradeAlertValueUsd: Number(minTradeAlertValueUsd),
    });

    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  // Independent Test Triggers
  const testLiveApi = async () => {
    setLiveApiTest({ status: 'testing' });
    try {
      const res = await fetch('/api/settings/test-live-api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: liveApiKey }),
      });
      const data = await res.json();
      setLiveApiTest({ status: data.ok ? 'ok' : 'fail', latencyMs: data.latencyMs, message: data.message || data.error });
    } catch {
      setLiveApiTest({ status: 'fail', message: 'Test request failed' });
    }
  };

  const testPaperApi = async () => {
    setPaperApiTest({ status: 'testing' });
    try {
      const res = await fetch('/api/settings/test-paper-api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: paperApiKey }),
      });
      const data = await res.json();
      setPaperApiTest({ status: data.ok ? 'ok' : 'fail', latencyMs: data.latencyMs, message: data.message || data.error });
    } catch {
      setPaperApiTest({ status: 'fail', message: 'Test request failed' });
    }
  };

  const testPrimaryRpc = async () => {
    setPrimaryRpcTest({ status: 'testing' });
    try {
      const res = await fetch('/api/settings/test-primary-rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: primaryRpcUrl }),
      });
      const data = await res.json();
      setPrimaryRpcTest({
        status: data.ok ? 'ok' : 'fail',
        latencyMs: data.latencyMs,
        message: data.ok ? `Slot ${data.slot}` : data.error,
      });
    } catch {
      setPrimaryRpcTest({ status: 'fail', message: 'Connection timed out' });
    }
  };

  const testSecondaryRpc = async () => {
    setSecondaryRpcTest({ status: 'testing' });
    try {
      const res = await fetch('/api/settings/test-secondary-rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: secondaryRpcUrl }),
      });
      const data = await res.json();
      setSecondaryRpcTest({
        status: data.ok ? 'ok' : 'fail',
        latencyMs: data.latencyMs,
        message: data.ok ? `Slot ${data.slot}` : data.error,
      });
    } catch {
      setSecondaryRpcTest({ status: 'fail', message: 'Connection timed out' });
    }
  };

  const testPrimaryLaserstream = async () => {
    setPrimaryLsTest({ status: 'testing' });
    try {
      const res = await fetch('/api/settings/test-primary-laserstream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: primaryLaserstream }),
      });
      const data = await res.json();
      setPrimaryLsTest({ status: data.ok ? 'ok' : 'fail', latencyMs: data.latencyMs, message: data.endpoint });
    } catch {
      setPrimaryLsTest({ status: 'fail', message: 'Stream unreachable' });
    }
  };

  const testSecondaryLaserstream = async () => {
    setSecondaryLsTest({ status: 'testing' });
    try {
      const res = await fetch('/api/settings/test-secondary-laserstream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: secondaryLaserstream }),
      });
      const data = await res.json();
      setSecondaryLsTest({ status: data.ok ? 'ok' : 'fail', latencyMs: data.latencyMs, message: data.endpoint });
    } catch {
      setSecondaryLsTest({ status: 'fail', message: 'Secondary stream unreachable' });
    }
  };

  const testJupiter = async () => {
    const trimmed = jupiterApiKey.trim();
    if (trimmed !== '' && !trimmed.toUpperCase().startsWith('JUP')) {
      setJupiterKeyError('Jupiter API key must start with "JUP"');
      setJupiterTest({ status: 'fail', message: 'Must start with JUP' });
      return;
    }
    setJupiterKeyError('');
    setJupiterTest({ status: 'testing' });
    try {
      const res = await fetch('/api/settings/test-jupiter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: trimmed }),
      });
      const data = await res.json();
      setJupiterTest({
        status: data.ok ? 'ok' : 'fail',
        latencyMs: data.latencyMs,
        message: data.ok ? 'Quote API Active' : data.error,
      });
    } catch {
      setJupiterTest({ status: 'fail', message: 'Jupiter request failed' });
    }
  };

  const testWss = async () => {
    setWssTest({ status: 'testing' });
    try {
      const res = await fetch('/api/settings/test-wss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: solanaWssUrl }),
      });
      const data = await res.json();
      setWssTest({
        status: data.ok ? 'ok' : 'fail',
        latencyMs: data.latencyMs,
        message: data.ok ? 'WSS Handshake Confirmed' : data.error,
      });
    } catch {
      setWssTest({ status: 'fail', message: 'WebSocket handshake failed' });
    }
  };

  const renderBadge = (res: TestResult) => {
    if (res.status === 'idle') return null;
    if (res.status === 'testing') {
      return (
        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#eab308]/15 text-[#fde047] border border-[#eab308]/30 animate-pulse">
          TESTING...
        </span>
      );
    }
    if (res.status === 'ok') {
      return (
        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30 flex items-center gap-1">
          <Check className="w-3 h-3" /> OK {res.latencyMs ? `(${res.latencyMs}ms)` : ''}
        </span>
      );
    }
    return (
      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#ef4444]/15 text-[#ef4444] border border-[#ef4444]/30 flex items-center gap-1">
        <AlertCircle className="w-3 h-3" /> FAIL {res.message ? `— ${res.message}` : ''}
      </span>
    );
  };

  return (
    <div className="space-y-4 font-mono text-xs max-w-5xl mx-auto">
      {/* Header */}
      <div className="bg-[#18181b] border border-[#27272a] rounded p-3 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#fafafa] flex items-center gap-2">
            <Settings className="w-4 h-4 text-[#00FF88]" />
            SYSTEM CONFIGURATION & ISOLATED PIPELINES
          </h2>
          <p className="text-[10px] text-[#71717a] mt-0.5">
            Strict isolation between Live Ingestion and Paper-Trading execution pipelines with granular endpoint testing.
          </p>
        </div>

        {savedSuccess && (
          <span className="flex items-center gap-1 text-[#00FF88] font-bold bg-[#00FF88]/10 border border-[#00FF88]/30 px-2.5 py-0.5 rounded text-[11px]">
            <Check className="w-3.5 h-3.5" /> SAVED
          </span>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        {/* SECTION 1: DUAL RPC CONFIGURATION */}
        <div className="bg-[#18181b] border border-[#27272a] rounded p-3 space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-[#27272a]">
            <span className="font-bold text-[#fafafa] uppercase text-[11px] flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-[#00FF88]" />
              Dual RPC Configuration (Primary & Secondary Failover)
            </span>
            <span className="text-[10px] text-[#71717a]">HTTP/HTTPS Endpoints</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[#fafafa] font-bold text-[11px]">Primary RPC Endpoint:</label>
                {renderBadge(primaryRpcTest)}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  required
                  value={primaryRpcUrl}
                  onChange={(e) => setPrimaryRpcUrl(e.target.value)}
                  className="flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
                />
                <button
                  type="button"
                  onClick={testPrimaryRpc}
                  className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[10px]"
                >
                  TEST PRIMARY RPC
                </button>
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[#fafafa] font-bold text-[11px]">Secondary Failover RPC Endpoint:</label>
                {renderBadge(secondaryRpcTest)}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={secondaryRpcUrl}
                  onChange={(e) => setSecondaryRpcUrl(e.target.value)}
                  className="flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
                />
                <button
                  type="button"
                  onClick={testSecondaryRpc}
                  className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[10px]"
                >
                  TEST SECONDARY RPC
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* SECTION 2: DUAL LASERSTREAM & WSS CONFIGURATION */}
        <div className="bg-[#18181b] border border-[#27272a] rounded p-3 space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-[#27272a]">
            <span className="font-bold text-[#fafafa] uppercase text-[11px] flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-[#3b82f6]" />
              Dual LaserStream & Solana WSS Stream Ingestion
            </span>
            <span className="text-[10px] text-[#71717a]">gRPC / WebSocket Streams</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[#fafafa] font-bold text-[11px]">Primary LaserStream Endpoint:</label>
                {renderBadge(primaryLsTest)}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  required
                  value={primaryLaserstream}
                  onChange={(e) => setPrimaryLaserstream(e.target.value)}
                  className="flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
                />
                <button
                  type="button"
                  onClick={testPrimaryLaserstream}
                  className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[10px]"
                >
                  TEST PRIMARY STREAM
                </button>
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[#fafafa] font-bold text-[11px]">Secondary LaserStream Endpoint:</label>
                {renderBadge(secondaryLsTest)}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={secondaryLaserstream}
                  onChange={(e) => setSecondaryLaserstream(e.target.value)}
                  className="flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
                />
                <button
                  type="button"
                  onClick={testSecondaryLaserstream}
                  className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[10px]"
                >
                  TEST SECONDARY STREAM
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-1 pt-2 border-t border-[#27272a]">
            <div className="flex items-center justify-between">
              <label className="text-[#fafafa] font-bold text-[11px] flex items-center gap-1.5">
                <Globe className="w-3 h-3 text-[#00FF88]" />
                Solana WSS URL (Handshake & Account Subscriptions):
              </label>
              {renderBadge(wssTest)}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                required
                value={solanaWssUrl}
                onChange={(e) => setSolanaWssUrl(e.target.value)}
                placeholder="wss://api.mainnet-beta.solana.com"
                className="flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
              />
              <button
                type="button"
                onClick={testWss}
                className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[10px]"
              >
                TEST SOLANA WSS
              </button>
            </div>
          </div>
        </div>

        {/* SECTION 3: ISOLATED API KEYS */}
        <div className="bg-[#18181b] border border-[#27272a] rounded p-3 space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-[#27272a]">
            <span className="font-bold text-[#fafafa] uppercase text-[11px] flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-[#ff9100]" />
              Isolated Pipeline API Keys (Live vs. Paper Isolation)
            </span>
            <span className="text-[10px] text-[#71717a]">Masked & Server-Only</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Live API Key */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[#fafafa] font-bold text-[11px]">Live Streaming API Key:</label>
                {renderBadge(liveApiTest)}
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={liveApiKey}
                  onChange={(e) => setLiveApiKey(e.target.value)}
                  placeholder="live_api_key_..."
                  className="flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
                />
                <button
                  type="button"
                  onClick={testLiveApi}
                  className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[10px]"
                >
                  TEST LIVE API
                </button>
              </div>
              <p className="text-[9px] text-[#71717a]">Dedicated to Live stream decoding only.</p>
            </div>

            {/* Paper API Key */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[#fafafa] font-bold text-[11px]">Paper Trading API Key:</label>
                {renderBadge(paperApiTest)}
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={paperApiKey}
                  onChange={(e) => setPaperApiKey(e.target.value)}
                  placeholder="paper_api_key_..."
                  className="flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
                />
                <button
                  type="button"
                  onClick={testPaperApi}
                  className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[10px]"
                >
                  TEST PAPER API
                </button>
              </div>
              <p className="text-[9px] text-[#71717a]">Dedicated to simulated quote verification & execution.</p>
            </div>
          </div>

          {/* Jupiter API Key */}
          <div className="space-y-1 pt-2 border-t border-[#27272a]">
            <div className="flex items-center justify-between">
              <label className="text-[#fafafa] font-bold text-[11px] flex items-center gap-1.5">
                <Key className="w-3 h-3 text-[#00FF88]" />
                Jupiter Price & Quote API Key (Format: Must start with &quot;JUP&quot;):
              </label>
              {renderBadge(jupiterTest)}
            </div>
            <div className="flex gap-2">
              <input
                type="password"
                value={jupiterApiKey}
                onChange={(e) => {
                  setJupiterApiKey(e.target.value);
                  setJupiterKeyError('');
                }}
                placeholder="JUP..."
                className={`flex-1 px-2.5 py-1.5 rounded bg-[#09090b] border text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88] ${
                  jupiterKeyError ? 'border-[#ef4444]' : 'border-[#27272a]'
                }`}
              />
              <button
                type="button"
                onClick={testJupiter}
                className="px-2 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[10px]"
              >
                TEST JUPITER API
              </button>
            </div>
            {jupiterKeyError ? (
              <p className="text-[10px] text-[#ef4444] mt-1">{jupiterKeyError}</p>
            ) : (
              <p className="text-[9px] text-[#71717a]">
                Validates format (must start with JUP). Used for live token price lookups and size-aware execution quotes.
              </p>
            )}
          </div>
        </div>

        {/* SECTION 4: WEBHOOK & ALERTS */}
        <div className="bg-[#18181b] border border-[#27272a] rounded p-3 space-y-3">
          <span className="font-bold text-[#fafafa] uppercase text-[11px] block pb-2 border-b border-[#27272a]">
            Webhook Notifications & Thresholds
          </span>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[#fafafa] font-bold text-[11px]">Discord / Telegram Webhook URL:</label>
              <input
                type="text"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://discord.com/api/webhooks/..."
                className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[#fafafa] font-bold text-[11px]">Minimum Trade Alert Value ($ USD):</label>
              <input
                type="number"
                min="0"
                value={minTradeAlertValueUsd}
                onChange={(e) => setMinTradeAlertValueUsd(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] font-mono text-xs focus:outline-none focus:border-[#00FF88]"
              />
            </div>
          </div>
        </div>

        {/* Save button bar */}
        <div className="flex justify-end pt-1">
          <button
            type="submit"
            className="px-5 py-2 rounded bg-[#00FF88] text-[#09090b] font-bold text-xs hover:bg-[#00e67a] shadow-md uppercase tracking-wider"
          >
            SAVE CONFIGURATION
          </button>
        </div>
      </form>

      {/* SECTION 5: ACCEPTANCE TEST RUNNER */}
      <div className="bg-[#18181b] border border-[#27272a] rounded p-3 space-y-3">
        <h3 className="text-xs font-bold text-[#fafafa] uppercase tracking-wider flex items-center gap-2">
          <Play className="w-4 h-4 text-[#3b82f6]" />
          AUTOMATED ACCEPTANCE TEST SUITE (24 STEPS)
        </h3>

        <p className="text-[10px] text-[#71717a]">
          Validates entire terminal architecture: RPC entry → LaserStream key → Wallet addition → Ingestion → Decoder → Single Classifier → Position Engine → Deduplicator → P&L verification → Exit.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              setTestLoading(true);
              await onRunTest();
              setTestLoading(false);
            }}
            disabled={testLoading}
            className="px-3 py-1.5 rounded bg-[#00FF88] text-[#09090b] font-bold text-[11px] hover:bg-[#00e67a] disabled:opacity-50"
          >
            {testLoading ? 'RUNNING 24-STEP SUITE...' : 'EXECUTE 24-STEP TEST SUITE'}
          </button>

          <button
            type="button"
            onClick={onClearData}
            className="px-3 py-1.5 rounded bg-[#ef4444]/10 text-[#ef4444] border border-[#ef4444]/30 font-bold text-[11px] hover:bg-[#ef4444]/20"
          >
            CLEAR STORED TRADES & POSITIONS
          </button>
        </div>

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
