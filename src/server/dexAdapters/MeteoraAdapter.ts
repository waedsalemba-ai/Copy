import { RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { BaseDexAdapter, SOL_MINT } from './BaseDexAdapter';
import { DexProtocol } from '../../types';

export class MeteoraAdapter extends BaseDexAdapter {
  dexName: DexProtocol = 'Meteora';
  programIds: string[] = [
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora Dynamic AMM / DAMM v1
  ];

  override identifyTransaction(tx: RawSolanaTransaction): boolean {
    return super.identifyTransaction(tx) ||
      Boolean(tx.logMessages?.some((log) => log.includes('LBUZKh') || log.includes('Meteora')));
  }

  decodeSwap(tx: RawSolanaTransaction): DecodedSwapResult | null {
    if (!this.identifyTransaction(tx)) return null;

    const solDelta = tx.preSolBalance - tx.postSolBalance;
    const isBuy = solDelta > 0.001;

    const tokenMint = (tx.postTokenBalance?.mint && tx.postTokenBalance.mint !== SOL_MINT)
      ? tx.postTokenBalance.mint
      : (tx.preTokenBalance?.mint && tx.preTokenBalance.mint !== SOL_MINT)
      ? tx.preTokenBalance.mint
      : 'UNKNOWN';
    const tokenDelta = Math.abs((tx.postTokenBalance?.amount || 0) - (tx.preTokenBalance?.amount || 0));

    return {
      isSwap: true,
      dex: this.dexName,
      inputTokenMint: isBuy ? SOL_MINT : tokenMint,
      inputAmount: isBuy ? Math.abs(solDelta) : tokenDelta || 10,
      outputTokenMint: isBuy ? tokenMint : SOL_MINT,
      outputAmount: isBuy ? tokenDelta || 10 : Math.abs(solDelta),
      poolAddress: 'Meteora-DLMM-Bin',
      confidence: 0.96,
    };
  }

  override identifyPool(_tx: RawSolanaTransaction): string {
    return 'Meteora-DLMM-Bin';
  }
}

