import { db } from './db';
import { eventBus, SystemEvents } from './eventBus';

export class HistoricalSyncService {
  public async syncWalletHistory(walletAddress: string): Promise<number> {
    const wallet = db.getWalletByAddress(walletAddress);
    if (!wallet) return 0;

    eventBus.emit(SystemEvents.SYSTEM_ALERT, {
      id: `sync_start_${Date.now()}`,
      type: 'WALLET_ACTIVITY',
      title: 'Historical Sync Started',
      message: `Loading historical transaction history for ${wallet.traderName} (${walletAddress.slice(0, 6)}...)`,
      walletAddress,
      timestamp: Date.now(),
      read: false,
    });

    db.updateWallet(walletAddress, {
      lastActivity: Date.now(),
    });

    eventBus.emit(SystemEvents.SYSTEM_ALERT, {
      id: `sync_end_${Date.now()}`,
      type: 'WALLET_ACTIVITY',
      title: 'Historical Sync Completed',
      message: `Successfully synchronized history for ${wallet.traderName}. Switched to live LaserStream monitoring.`,
      walletAddress,
      timestamp: Date.now(),
      read: false,
    });

    return 0;
  }
}

export const historicalSyncService = new HistoricalSyncService();
