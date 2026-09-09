import { IDexAdapter, RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { DexProtocol } from '../../types';

export class JupiterAdapter implements IDexAdapter {
  dexName: DexProtocol = 'Jupiter';
  programIds: string[] = [
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter V6 primary
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // Jupiter V6 secondary deployment
    'JUP5pEAZeHdHrLxh5UCwAbpjGwYKKoquCpda2hfP4u8', // Jupiter V5 (5.0.1)
    'JUP5cHjnnCx2DppVsufsLrXs8EBZeEZzGtEK9Gdz6ow', // Jupiter V5 (5.2.0)
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter V4
  ];

  identifyTransaction(tx: RawSolanaTransaction): boolean {
    const matched = tx.instructions.some((ix) => this.programIds.includes(ix.programId)) ||
      (tx.logMessages && tx.logMessages.some((log) => log.includes('JUP6Lkb') || log.includes('Jupiter')));
    return Boolean(matched);
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
    if (tx.preTokenBalance?.mint) return tx.preTokenBalance.mint;
    if (tx.postTokenBalance?.mint) return tx.postTokenBalance.mint;
    return null;
  }

  identifyExecutionPrice(inputAmount: number, outputAmount: number): number {
    return inputAmount > 0 ? outputAmount / inputAmount : 0;
  }

  identifyPool(tx: RawSolanaTransaction): string | null {
    return 'Jupiter-Aggregator-Route';
  }
}
