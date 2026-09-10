import { PublicKey } from '@solana/web3.js';
import { db } from './db';
import { eventBus, SystemEvents } from './eventBus';
import { rpcService } from './rpcService';
import { laserStreamService } from './laserStreamService';

// How many of the wallet's most recent transactions to check when backfilling.
// Not all of these will be trades (transfers, approvals, etc. classify as
// UNKNOWN and are skipped from the "imported" count below).
const HISTORY_LOOKBACK_COUNT = 20;

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

    let importedCount = 0;
    try {
      const pubkey = new PublicKey(walletAddress);
      const sigInfos = await rpcService.getSignaturesForAddress(pubkey, { limit: HISTORY_LOOKBACK_COUNT });

      // Oldest first, so trades land in the feed/position engine in
      // chronological order rather than reverse.
      const ordered = [...sigInfos].reverse();

      for (const sigInfo of ordered) {
        if (sigInfo.err) continue;
        try {
          const wasIngested = await laserStreamService.processHistoricalTransaction(walletAddress, sigInfo.signature);
          if (wasIngested) importedCount++;
        } catch {
          // Skip individual failures (bad decode, RPC hiccup) and keep backfilling the rest.
        }
        // Pace requests; rpcService's shared rate limiter also throttles the underlying calls.
        await new Promise((r) => setTimeout(r, 120));
      }
    } catch {
      // Historical backfill is best-effort. Live monitoring (already subscribed
      // before this runs) keeps working even if the backfill fails entirely.
    }

    db.updateWallet(walletAddress, {
      lastActivity: Date.now(),
    });

    eventBus.emit(SystemEvents.SYSTEM_ALERT, {
      id: `sync_end_${Date.now()}`,
      type: 'WALLET_ACTIVITY',
      title: 'Historical Sync Completed',
      message:
        importedCount > 0
          ? `Imported ${importedCount} recent trade${importedCount === 1 ? '' : 's'} for ${wallet.traderName}. Switched to live monitoring.`
          : `No recent trades found in ${wallet.traderName}'s last ${HISTORY_LOOKBACK_COUNT} transactions. Switched to live monitoring.`,
      walletAddress,
      timestamp: Date.now(),
      read: false,
    });

    return importedCount;
  }
}

export const historicalSyncService = new HistoricalSyncService();
