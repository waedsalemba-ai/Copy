import { CanonicalTradeEvent, SystemAlert } from '../types';
import { db } from './db';
import { eventBus, SystemEvents } from './eventBus';

export class AlertEngine {
  private alertedSignatures = new Set<string>();

  constructor() {
    this.listenToEvents();
  }

  private listenToEvents(): void {
    eventBus.on(SystemEvents.TRADE_DETECTED, (trade: CanonicalTradeEvent) => {
      this.evaluateTradeForAlerts(trade);
    });

    eventBus.on(SystemEvents.CONNECTION_STATUS_CHANGED, (status: any) => {
      if (!status.laserstreamConnected || !status.rpcConnected) {
        this.emitAlert({
          type: 'CONNECTION_FAILURE',
          title: 'Connection Status Alert',
          message: `LaserStream: ${status.laserstreamConnected ? 'CONNECTED' : 'DISCONNECTED'}, RPC: ${status.rpcConnected ? 'CONNECTED' : 'DISCONNECTED'}`,
        });
      }
    });
  }

  public evaluateTradeForAlerts(trade: CanonicalTradeEvent): void {
    // Deduplication check
    if (this.alertedSignatures.has(trade.signature)) {
      return;
    }
    this.alertedSignatures.add(trade.signature);
    if (this.alertedSignatures.size > 2000) {
      const iterator = this.alertedSignatures.values();
      for (let i = 0; i < 500; i++) {
        const next = iterator.next();
        if (!next.done) this.alertedSignatures.delete(next.value);
      }
    }

    const wallet = db.getWalletByAddress(trade.walletAddress);
    const alertSettings = wallet?.alertSettings;

    // Global minimum USD trade value below which buy/sell alerts are
    // suppressed entirely (large-trade alerts use their own SOL threshold
    // below and are intentionally not gated by this).
    const minUsd = db.getSettings().minTradeAlertValueUsd || 0;
    const meetsMinUsd = trade.usdValue >= minUsd;

    if (trade.action === 'BUY' && alertSettings?.buyAlert !== false && meetsMinUsd) {
      this.emitAlert({
        type: 'BUY',
        title: `🟢 BUY Alert - ${trade.traderName}`,
        message: `${trade.traderName} bought ${trade.tokenAmount.toLocaleString()} ${trade.tokenSymbol} for ${trade.solAmount.toFixed(2)} SOL via ${trade.dex}`,
        traderName: trade.traderName,
        walletAddress: trade.walletAddress,
        signature: trade.signature,
        usdValue: trade.usdValue,
      });
    } else if (trade.action === 'SELL' && alertSettings?.sellAlert !== false && meetsMinUsd) {
      this.emitAlert({
        type: 'SELL',
        title: `🔴 SELL Alert - ${trade.traderName}`,
        message: `${trade.traderName} sold ${trade.tokenAmount.toLocaleString()} ${trade.tokenSymbol} for ${trade.solAmount.toFixed(2)} SOL via ${trade.dex}`,
        traderName: trade.traderName,
        walletAddress: trade.walletAddress,
        signature: trade.signature,
        usdValue: trade.usdValue,
      });
    }

    // Large trade alert
    if (alertSettings && trade.solAmount >= alertSettings.largeTradeThresholdSol) {
      this.emitAlert({
        type: 'LARGE_TRADE',
        title: `🔥 Large Trade Detected (${trade.solAmount.toFixed(2)} SOL)`,
        message: `${trade.traderName} executed a ${trade.solAmount.toFixed(2)} SOL (${trade.action}) trade on ${trade.tokenSymbol}`,
        traderName: trade.traderName,
        walletAddress: trade.walletAddress,
        signature: trade.signature,
        usdValue: trade.usdValue,
      });
    }
  }

  private emitAlert(params: Omit<SystemAlert, 'id' | 'timestamp' | 'read'>): void {
    const alert: SystemAlert = {
      id: `alert_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      timestamp: Date.now(),
      read: false,
      ...params,
    };

    db.addAlert(alert);
    eventBus.emit(SystemEvents.SYSTEM_ALERT, alert);

    // Trigger Webhook asynchronously if configured
    const settings = db.getSettings();
    if (settings.webhookUrl) {
      this.triggerWebhook(settings.webhookUrl, alert).catch(() => {});
    }
  }

  private async triggerWebhook(url: string, alert: SystemAlert) {
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch {
      // Ignore webhook network failures silently
    }
  }
}

export const alertEngine = new AlertEngine();
