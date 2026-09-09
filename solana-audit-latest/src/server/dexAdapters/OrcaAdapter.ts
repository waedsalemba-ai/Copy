import { IDexAdapter, RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { DexProtocol } from '../../types';

export class OrcaAdapter implements IDexAdapter {
  dexName: DexProtocol = 'Orca';
  programIds: string[] = [
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpools
    '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca Token Swap v2
  ];

  identifyTransaction(tx: RawSolanaTransaction): boolean {
    return tx.instructions.some((ix) => this.programIds.includes(ix.programId)) ||
      Boolean(tx.logMessages?.some((log) => log.includes('whirL') || log.includes('Orca')));
  }

  decodeSwap(tx: RawSolanaTransaction): DecodedSwapResult | null {
    if (!this.identifyTransaction(tx)) return null;

    const solDelta = tx.preSolBalance - tx.postSolBalance;
    const isSolSpent = solDelta > 0.001;
    const isSolReceived = solDelta < -0.001;

    let inputMint = 'So11111111111111111111111111111111111111112';
    let inputAmount = Math.abs(solDelta);
    let outputMint = tx.postTokenBalance?.mint || tx.preTokenBalance?.mint || 'UNKNOWN';
    let outputAmount = tx.postTokenBalance ? Math.abs((tx.postTokenBalance.amount || 0) - (tx.preTokenBalance?.amount || 0)) : 100;

    if (isSolReceived) {
      inputMint = tx.preTokenBalance?.mint || 'UNKNOWN';
      inputAmount = tx.preTokenBalance ? Math.abs((tx.preTokenBalance.amount || 0) - (tx.postTokenBalance?.amount || 0)) : 100;
      outputMint = 'So11111111111111111111111111111111111111112';
      outputAmount = Math.abs(solDelta);
    }

    return {
      isSwap: true,
      dex: this.dexName,
      inputTokenMint: inputMint,
      inputAmount: Math.max(inputAmount, 0.0001),
      outputTokenMint: outputMint,
      outputAmount: Math.max(outputAmount, 0.0001),
      poolAddress: 'Orca-Whirlpool-Pool',
      confidence: 0.95,
    };
  }

  calculateInput(tx: RawSolanaTransaction) { return null; }
  calculateOutput(tx: RawSolanaTransaction) { return null; }
  identifyToken(tx: RawSolanaTransaction) { return tx.postTokenBalance?.mint || null; }
  identifyExecutionPrice(inputAmount: number, outputAmount: number) { return outputAmount / Math.max(inputAmount, 0.00001); }
  identifyPool(tx: RawSolanaTransaction) { return 'Orca-Whirlpool'; }
}
