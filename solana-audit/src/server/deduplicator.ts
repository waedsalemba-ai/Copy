import { db } from './db';

export class Deduplicator {
  private processedKeys = new Set<string>();

  public generateKey(signature: string, walletAddress: string, action?: string): string {
    return `${signature}:${walletAddress.toLowerCase()}:${action || 'all'}`;
  }

  public isDuplicate(signature: string, walletAddress: string, action?: string): boolean {
    const key = this.generateKey(signature, walletAddress, action);
    if (this.processedKeys.has(key)) {
      // Increment duplicate counter metric
      const metrics = db.getMetrics();
      db.updateMetrics({ duplicateCount: metrics.duplicateCount + 1 });
      return true;
    }
    return false;
  }

  public markProcessed(signature: string, walletAddress: string, action?: string): void {
    const key = this.generateKey(signature, walletAddress, action);
    this.processedKeys.add(key);

    // Keep deduplication memory window bounded (e.g., last 10,000 keys)
    if (this.processedKeys.size > 10000) {
      const iterator = this.processedKeys.values();
      for (let i = 0; i < 2000; i++) {
        const next = iterator.next();
        if (!next.done) {
          this.processedKeys.delete(next.value);
        }
      }
    }
  }

  public clear(): void {
    this.processedKeys.clear();
  }
}

export const deduplicator = new Deduplicator();
