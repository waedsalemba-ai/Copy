import { RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { BaseDexAdapter } from './BaseDexAdapter';
import { DexProtocol } from '../../types';

export class JupiterAdapter extends BaseDexAdapter {
  dexName: DexProtocol = 'Jupiter';
  programIds: string[] = [
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter V6 primary
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // Jupiter V6 secondary deployment
    'JUP5pEAZeHdHrLxh5UCwAbpjGwYKKoquCpda2hfP4u8', // Jupiter V5 (5.0.1)
    'JUP5cHjnnCx2DppVsufsLrXs8EBZeEZzGtEK9Gdz6ow', // Jupiter V5 (5.2.0)
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter V4
  ];

  override identifyTransaction(tx: RawSolanaTransaction): boolean {
    return super.identifyTransaction(tx) ||
      Boolean(tx.logMessages?.some((log) => log.includes('JUP6Lkb') || log.includes('Jupiter')));
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
    return 'Jupiter-Aggregator-Route';
  }
}

