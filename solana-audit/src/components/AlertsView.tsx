import React from 'react';
import {
  Bell,
  Volume2,
  VolumeX,
  Check,
  Zap,
  Globe,
  Radio,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
} from 'lucide-react';
import { SystemAlert } from '../types';
import { audioSynth } from './AudioSynth';

interface AlertsViewProps {
  alerts: SystemAlert[];
  onMarkRead: () => void;
  audioEnabled: boolean;
  setAudioEnabled: (val: boolean) => void;
}

export const AlertsView: React.FC<AlertsViewProps> = ({
  alerts,
  onMarkRead,
  audioEnabled,
  setAudioEnabled,
}) => {
  const handleTestAudio = () => {
    audioSynth.playBuyChime();
    setTimeout(() => audioSynth.playSellChime(), 350);
  };

  const getAlertIcon = (type: string) => {
    switch (type) {
      case 'BUY':
        return <ArrowUpRight className="w-4 h-4 text-[#00FF88]" />;
      case 'SELL':
        return <ArrowDownRight className="w-4 h-4 text-[#ef4444]" />;
      case 'LARGE_TRADE':
        return <Zap className="w-4 h-4 text-[#00FF88]" />;
      case 'CONNECTION_FAILURE':
        return <AlertTriangle className="w-4 h-4 text-[#ef4444]" />;
      default:
        return <Bell className="w-4 h-4 text-[#3b82f6]" />;
    }
  };

  return (
    <div className="space-y-3 font-mono text-xs">
      {/* Alert Controls & Synth Test */}
      <div className="bg-[#18181b] border border-[#27272a] rounded p-3 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-bold text-[#fafafa] uppercase tracking-wider flex items-center gap-2">
            <Bell className="w-4 h-4 text-[#00FF88]" />
            ALERT NOTIFICATION ENGINE
          </h2>
          <p className="text-[10px] text-[#71717a] mt-0.5">
            Deduplicated real-time alert system with browser audio synth and webhook delivery.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setAudioEnabled(!audioEnabled)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-bold transition-all ${
              audioEnabled
                ? 'bg-[#00FF88]/15 border-[#00FF88]/30 text-[#00FF88]'
                : 'bg-[#09090b] border-[#27272a] text-[#71717a]'
            }`}
          >
            {audioEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            <span>{audioEnabled ? 'AUDIO ON' : 'MUTED'}</span>
          </button>

          <button
            onClick={handleTestAudio}
            className="px-2.5 py-1 rounded bg-[#3b82f6]/10 text-[#3b82f6] border border-[#3b82f6]/30 hover:bg-[#3b82f6]/20 font-bold text-[11px] transition-all"
          >
            Test Sound Synth
          </button>

          <button
            onClick={onMarkRead}
            className="px-2.5 py-1 rounded bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:border-[#00FF88] font-bold text-[11px] transition-colors"
          >
            Mark All Read
          </button>
        </div>
      </div>

      {/* Alerts Log Table */}
      <div className="bg-[#18181b] border border-[#27272a] rounded p-3 shadow-md">
        <h3 className="text-xs font-bold text-[#fafafa] uppercase tracking-wider mb-2.5">
          RECENT SYSTEM ALERTS LOG ({alerts.length})
        </h3>

        <div className="space-y-1.5">
          {alerts.length === 0 ? (
            <div className="py-6 text-center text-[#71717a]">No alerts triggered yet.</div>
          ) : (
            alerts.map((a, idx) => (
              <div
                key={`${a.id}_${idx}`}
                className={`p-2.5 rounded border flex items-start justify-between gap-2 transition-all ${
                  a.read
                    ? 'bg-[#09090b]/50 border-[#27272a]/60 text-[#71717a]'
                    : 'bg-[#09090b] border-[#27272a] text-[#fafafa] shadow-sm'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <div className="p-1.5 rounded bg-[#18181b] border border-[#27272a]">
                    {getAlertIcon(a.type)}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <h4 className="font-bold text-[#fafafa] text-[11px]">{a.title}</h4>
                      {!a.read && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#00FF88] animate-ping"></span>
                      )}
                    </div>
                    <p className="text-[#71717a] text-[10px] mt-0.5">{a.message}</p>
                  </div>
                </div>

                <span className="text-[9px] text-[#71717a] whitespace-nowrap">
                  {new Date(a.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
