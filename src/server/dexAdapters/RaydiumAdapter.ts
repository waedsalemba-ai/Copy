import { RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { BaseDexAdapter } from './BaseDexAdapter';
import { DexProtocol } from '../../types';

export class RaydiumAdapter extends BaseDexAdapter {
  dexName: DexProtocol = 'Raydium';
  programIds: string[] = [
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS', // Raydium AMM Routing
    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium Standard AMM / CP-Swap
  ];

  override identifyTransaction(tx: RawSolanaTransaction): boolean {
    return super.identifyTransaction(tx) ||
      Boolean(tx.logMessages?.some((log) => log.includes('Raydium') || log.includes('675kPX9')));
  }

  decodeSwap(tx: RawSolanaTransaction): DecodedSwapResult | null {
    if (!this.identifyTransaction(tx)) return null;

    const input = this.calculateInput(tx);
    const output = this.calculateOutput(tx);
    if (!input || !output) return null;

    return {
      isSwap: true,
      dex: this.dexName,
      inputTokenMint: input.mint,
      inputAmount: input.amount,
      outputTokenMint: output.mint,
      outputAmount: output.amount,
      poolAddress: this.identifyPool(tx) || undefined,
      confidence: 0.98,
    };
  }

  override identifyPool(_tx: RawSolanaTransaction): string {
    return 'Raydium-AMM-Pool';
  }
}

