import { IDexAdapter, RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { JupiterAdapter } from './JupiterAdapter';
import { RaydiumAdapter } from './RaydiumAdapter';
import { OrcaAdapter } from './OrcaAdapter';
import { PumpFunAdapter } from './PumpFunAdapter';
import { MeteoraAdapter } from './MeteoraAdapter';

export class DexRegistry {
  private adapters: IDexAdapter[] = [
    new JupiterAdapter(),
    new RaydiumAdapter(),
    new OrcaAdapter(),
    new PumpFunAdapter(),
    new MeteoraAdapter(),
  ];

  public findAdapter(tx: RawSolanaTransaction): IDexAdapter | null {
    for (const adapter of this.adapters) {
      if (adapter.identifyTransaction(tx)) {
        return adapter;
      }
    }
    return null;
  }

  public decodeTransaction(tx: RawSolanaTransaction): DecodedSwapResult | null {
    const adapter = this.findAdapter(tx);
    if (adapter) {
      return adapter.decodeSwap(tx);
    }

    // Heuristic Fallback for generic/unknown DEX swaps
    const solDelta = tx.preSolBalance - tx.postSolBalance;
    const tokenDelta = Math.abs((tx.postTokenBalance?.amount || 0) - (tx.preTokenBalance?.amount || 0));

    if (Math.abs(solDelta) > 0.001 && tokenDelta > 0) {
      const isBuy = solDelta > 0;
      return {
        isSwap: true,
        dex: 'Unknown',
        inputTokenMint: isBuy ? 'So11111111111111111111111111111111111111112' : tx.preTokenBalance?.mint || 'UNKNOWN',
        inputAmount: isBuy ? Math.abs(solDelta) : tokenDelta,
        outputTokenMint: isBuy ? tx.postTokenBalance?.mint || 'UNKNOWN' : 'So11111111111111111111111111111111111111112',
        outputAmount: isBuy ? tokenDelta : Math.abs(solDelta),
        confidence: 0.65,
      };
    }

    return null;
  }
}

export const dexRegistry = new DexRegistry();
