import { db } from './db';
import { DiscoveredWallet } from '../types';

class WalletScannerService {
  private isScanning = false;
  private scanInterval: NodeJS.Timeout | null = null;

  public startScanner(): void {
    if (this.isScanning) return;
    this.isScanning = true;

    // Run discovery every 6 hours
    this.scanInterval = setInterval(() => {
      this.performDiscoveryScan().catch((err) => {
        console.error('[WalletScanner] Discovery scan failed:', err);
      });
    }, 6 * 60 * 60 * 1000);

    // Run once on startup after 5 seconds delay so server finishes booting
    setTimeout(() => {
      this.performDiscoveryScan().catch((err) => {
        console.error('[WalletScanner] Initial discovery scan failed:', err);
      });
    }, 5000);

    console.log('[WalletScanner] Discovery service started');
  }

  public stopScanner(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    this.isScanning = false;
    console.log('[WalletScanner] Discovery service stopped');
  }

  public async performDiscoveryScan(): Promise<DiscoveredWallet[]> {
    console.log('[WalletScanner] Starting discovery scan...');

    try {
      // 1. Fetch top momentum tokens from DexScreener (Solana)
      const response = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
      const data = await response.json();

      const discoveredWallets: DiscoveredWallet[] = [];

      if (data && Array.isArray(data.pairs)) {
        // Filter for momentum tokens (liquidity > $10k, 24h gain > 50%)
        const momentumTokens = data.pairs
          .filter(
            (pair: any) =>
              pair.chainId === 'solana' &&
              pair.liquidity?.usd > 10000 &&
              pair.priceChange?.h24 > 50 &&
              pair.volume?.h24 > 50000
          )
          .slice(0, 10);

        const allPositions = db.getPaperPositions();
        for (const token of momentumTokens) {
          const tokenMint = token.baseToken?.address;
          if (!tokenMint) continue;

          // Find wallets in DB that traded this token profitably
          const successfulTraders = allPositions.filter(
            (p) => p.tokenMint === tokenMint && p.status === 'CLOSED' && p.realizedPnlSol > 0
          );

          for (const pos of successfulTraders.slice(0, 3)) {
            const wallet = db.getWalletByAddress(pos.sourceWalletAddress);
            if (!wallet) continue;

            const winRate = wallet.metrics.winRatePercent || 50;
            const avgHold = wallet.metrics.avgHoldingTimeSeconds || 600;
            const riskScore = Math.max(1, Math.round((100 - winRate) + avgHold / 3600));

            discoveredWallets.push({
              address: pos.sourceWalletAddress,
              traderName: wallet.traderName || `Smart Money ${pos.sourceWalletAddress.slice(0, 4)}`,
              winRatePercent: winRate,
              totalTrades: wallet.metrics.totalBuys + wallet.metrics.totalSells,
              avgHoldingTimeSeconds: avgHold,
              recentPnlSol: pos.realizedPnlSol,
              riskScore,
              lastActive: pos.exitTimestamp || Date.now(),
            });
          }
        }
      }

      // If no position matches yet, fall back to evaluating monitored wallets in DB
      if (discoveredWallets.length === 0) {
        const monitoredWallets = db.getWallets();
        for (const w of monitoredWallets) {
          const winRate = w.metrics.winRatePercent || 60;
          const totalTrades = w.metrics.totalBuys + w.metrics.totalSells;
          const avgHold = w.metrics.avgHoldingTimeSeconds || 300;
          const riskScore = Math.max(1, Math.round((100 - winRate) + avgHold / 3600));

          discoveredWallets.push({
            address: w.address,
            traderName: w.traderName || `Trader ${w.address.slice(0, 4)}`,
            winRatePercent: winRate,
            totalTrades: totalTrades || 10,
            avgHoldingTimeSeconds: avgHold,
            recentPnlSol: Math.max(0.1, w.metrics.realizedPnlSol || 1.5),
            riskScore,
            lastActive: w.lastActivity || w.createdAt || Date.now(),
          });
        }
      }

      // Deduplicate and sort by highest win rate then lowest risk score
      const uniqueWallets = Array.from(new Map(discoveredWallets.map((w) => [w.address, w])).values())
        .sort((a, b) => b.winRatePercent - a.winRatePercent || a.riskScore - b.riskScore)
        .slice(0, 20);

      db.setDiscoveredWallets(uniqueWallets);
      console.log(`[WalletScanner] Discovery scan completed: found ${uniqueWallets.length} candidate wallets`);
      return uniqueWallets;
    } catch (err) {
      console.error('[WalletScanner] Discovery scan error:', err);
      return db.getDiscoveredWallets();
    }
  }

  public getDiscoveredWallets(): DiscoveredWallet[] {
    return db.getDiscoveredWallets();
  }
}

export const walletScannerService = new WalletScannerService();
