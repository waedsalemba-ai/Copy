import { IDexAdapter, RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { DexProtocol } from '../../types';

export class RaydiumAdapter implements IDexAdapter {
  dexName: DexProtocol = 'Raydium';
  programIds: string[] = [
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS', // Raydium AMM Routing
    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium Standard AMM / CP-Swap
  ];

  identifyTransaction(tx: RawSolanaTransaction): boolean {
    return tx.instructions.some((ix) => this.programIds.includes(ix.programId)) ||
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

  calculateInput(tx: RawSolanaTransaction): { mint: string; amount: number } | null {
    const solDelta = tx.preSolBalance - tx.postSolBalance;
    if (solDelta > 0.001) {
      return { mint: 'So11111111111111111111111111111111111111112', amount: solDelta };
    }
    if (tx.preTokenBalance && tx.postTokenBalance && tx.preTokenBalance.amount > tx.postTokenBalance.amount) {
      return {
        mint: tx.preTokenBalance.mint,
        amount: tx.preTokenBalance.amount - tx.postTokenBalance.amount,
      };
    }
    return null;
  }

  calculateOutput(tx: RawSolanaTransaction): { mint: string; amount: number } | null {
    const solDelta = tx.postSolBalance - tx.preSolBalance;
    if (solDelta > 0.001) {
      return { mint: 'So11111111111111111111111111111111111111112', amount: solDelta };
    }
    if (tx.preTokenBalance && tx.postTokenBalance && tx.postTokenBalance.amount > tx.preTokenBalance.amount) {
      return {
        mint: tx.postTokenBalance.mint,
        amount: tx.postTokenBalance.amount - tx.preTokenBalance.amount,
      };
    }
    return null;
  }

  identifyToken(tx: RawSolanaTransaction): string | null {
    return tx.preTokenBalance?.mint || tx.postTokenBalance?.mint || null;
  }

  identifyExecutionPrice(inputAmount: number, outputAmount: number): number {
    return inputAmount > 0 ? outputAmount / inputAmount : 0;
  }

  identifyPool(tx: RawSolanaTransaction): string | null {
    return 'Raydium-AMM-Pool';
  }
}
