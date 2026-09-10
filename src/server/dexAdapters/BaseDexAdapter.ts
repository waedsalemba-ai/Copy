import { IDexAdapter, RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { DexProtocol } from '../../types';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export abstract class BaseDexAdapter implements IDexAdapter {
  abstract dexName: DexProtocol;
  abstract programIds: string[];

  identifyTransaction(tx: RawSolanaTransaction): boolean {
    return tx.instructions.some((ix) => this.programIds.includes(ix.programId));
  }

  abstract decodeSwap(tx: RawSolanaTransaction): DecodedSwapResult | null;

  calculateInput(tx: RawSolanaTransaction): { mint: string; amount: number } | null {
    const solDelta = tx.preSolBalance - tx.postSolBalance;
    if (solDelta > 0.001) {
      return { mint: SOL_MINT, amount: solDelta };
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
      return { mint: SOL_MINT, amount: solDelta };
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
    return `${this.dexName}-Pool`;
  }
}
