import React from 'react';
import {
  Activity,
  Users,
  TrendingUp,
  PieChart,
  Bell,
  Cpu,
  Settings,
  Volume2,
  VolumeX,
  Play,
  CheckCircle2,
  Zap,
  Repeat,
  Flame,
} from 'lucide-react';
import { SystemMetrics } from '../types';
import { audioSynth } from './AudioSynth';

interface NavbarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  metrics: SystemMetrics;
  onRunTest: () => void;
  audioEnabled: boolean;
  setAudioEnabled: (val: boolean) => void;
  firebaseSynced?: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  metrics,
  onRunTest,
  audioEnabled,
  setAudioEnabled,
  firebaseSynced = true,
}) => {
  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: Activity },
    { id: 'traders', label: 'Traders', icon: Users },
    { id: 'trades', label: 'Live Trades', icon: TrendingUp },
    { id: 'positions', label: 'Positions', icon: PieChart },
    { id: 'paper', label: 'Paper Trading', icon: Repeat },
    { id: 'alerts', label: 'Alerts', icon: Bell },
    { id: 'observability', label: 'System Health', icon: Cpu },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const handleToggleAudio = () => {
    const next = !audioEnabled;
    setAudioEnabled(next);
    audioSynth.enabled = next;
    if (next) audioSynth.playBuyChime();
  };

  return (
    <header className="sticky top-0 z-40 bg-[#18181b] border-b border-[#27272a] px-4 py-2">
      <div className="max-w-[1600px] mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
        {/* Logo & Connection Status */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-8 h-8 rounded bg-[#00FF88]/10 border border-[#00FF88]/40 text-[#00FF88] font-mono font-bold text-base">
            S
            <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00FF88] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00FF88]"></span>
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xs font-mono font-bold tracking-tight text-[#fafafa] uppercase">
                SOLANA_TRADER_v2.0.4
              </h1>
              <span className="px-1.5 py-0.5 text-[9px] font-mono font-bold rounded bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30 uppercase">
                LaserStream Live
              </span>
            </div>
            <p className="text-[10px] text-[#71717a] flex items-center gap-2 font-mono">
              <span className="text-[#00FF88] font-bold flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[#00FF88]"></span>
                CONNECTED
              </span>
              <span className="text-[#27272a]">•</span>
              <span>Slot:</span>
              <span className="text-[#e4e4e7]">{metrics.lastSlot}</span>
            </p>
          </div>
        </div>

        {/* Tab Navigation */}
        <nav className="flex items-center gap-1 overflow-x-auto max-w-full pb-1 md:pb-0 scrollbar-none font-mono">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-bold uppercase transition-all whitespace-nowrap ${
                  isActive
                    ? 'bg-[#00FF88]/15 text-[#00FF88] border border-[#00FF88]/30 shadow-sm'
                    : 'text-[#71717a] hover:text-[#fafafa] hover:bg-[#27272a]/40'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-[#00FF88]' : 'text-[#71717a]'}`} />
                {tab.label}
              </button>
            );
          })}
        </nav>

        {/* Quick Actions & Metrics */}
        <div className="flex items-center gap-2">
          {/* Firebase Persistence Status */}
          <div
            title="Firebase Firestore Cloud Persistence Active: All trader wallets, settings, and paper trades are saved to Firestore"
            className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#09090b] border border-[#ff9100]/30 font-mono text-[11px] text-[#ffb74d]"
          >
            <Flame className="w-3.5 h-3.5 text-[#ff9100] animate-pulse" />
            <span className="hidden sm:inline text-[#a1a1aa]">Firebase:</span>
            <span className="font-bold text-[#ff9100]">
              {firebaseSynced ? 'SYNCED' : 'CONNECTING'}
            </span>
          </div>

          {/* Latency Badge */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#09090b] border border-[#27272a] font-mono text-[11px]">
            <Zap className="w-3 h-3 text-[#00FF88] animate-pulse" />
            <span className="text-[#71717a]">Latency:</span>
            <span className="text-[#00FF88] font-bold">{metrics.avgDetectionLatencyMs}ms</span>
          </div>

          {/* Audio Chime Toggle */}
          <button
            onClick={handleToggleAudio}
            title={audioEnabled ? 'Audio Chimes Enabled' : 'Audio Chimes Muted'}
            className={`p-1.5 rounded border text-xs transition-colors ${
              audioEnabled
                ? 'bg-[#00FF88]/10 border-[#00FF88]/30 text-[#00FF88]'
                : 'bg-[#09090b] border-[#27272a] text-[#71717a] hover:text-[#fafafa]'
            }`}
          >
            {audioEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>

          {/* Run 24-Step Acceptance Test */}
          <button
            onClick={onRunTest}
            title="Run 24-Step Acceptance Test Suite"
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#00FF88] text-[#09090b] font-mono font-bold text-[11px] hover:bg-[#00e67a] transition-all shadow-sm"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>RUN SUITE</span>
          </button>
        </div>
      </div>
    </header>
  );
};
