import { RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { BaseDexAdapter, SOL_MINT } from './BaseDexAdapter';
import { DexProtocol } from '../../types';

export class OrcaAdapter extends BaseDexAdapter {
  dexName: DexProtocol = 'Orca';
  programIds: string[] = [
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpools
    '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca Token Swap v2
  ];

  override identifyTransaction(tx: RawSolanaTransaction): boolean {
    return super.identifyTransaction(tx) ||
      Boolean(tx.logMessages?.some((log) => log.includes('whirL') || log.includes('Orca')));
  }

  decodeSwap(tx: RawSolanaTransaction): DecodedSwapResult | null {
    if (!this.identifyTransaction(tx)) return null;

    const solDelta = tx.preSolBalance - tx.postSolBalance;
    const isSolReceived = solDelta < -0.001;

    let inputMint = SOL_MINT;
    let inputAmount = Math.abs(solDelta);
    let outputMint = tx.postTokenBalance?.mint || tx.preTokenBalance?.mint || 'UNKNOWN';
    let outputAmount = tx.postTokenBalance ? Math.abs((tx.postTokenBalance.amount || 0) - (tx.preTokenBalance?.amount || 0)) : 100;

    if (isSolReceived) {
      inputMint = tx.preTokenBalance?.mint || 'UNKNOWN';
      inputAmount = tx.preTokenBalance ? Math.abs((tx.preTokenBalance.amount || 0) - (tx.postTokenBalance?.amount || 0)) : 100;
      outputMint = SOL_MINT;
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

  override identifyPool(_tx: RawSolanaTransaction): string {
    return 'Orca-Whirlpool';
  }
}

