import { IDexAdapter, RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { DexProtocol } from '../../types';

export class MeteoraAdapter implements IDexAdapter {
  dexName: DexProtocol = 'Meteora';
  programIds: string[] = [
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora Dynamic AMM / DAMM v1
  ];

  identifyTransaction(tx: RawSolanaTransaction): boolean {
    return tx.instructions.some((ix) => this.programIds.includes(ix.programId)) ||
      Boolean(tx.logMessages?.some((log) => log.includes('LBUZKh') || log.includes('Meteora')));
  }

  decodeSwap(tx: RawSolanaTransaction): DecodedSwapResult | null {
    if (!this.identifyTransaction(tx)) return null;

    const solDelta = tx.preSolBalance - tx.postSolBalance;
    const isBuy = solDelta > 0.001;

    const solMint = 'So11111111111111111111111111111111111111112';
    const tokenMint = (tx.postTokenBalance?.mint && tx.postTokenBalance.mint !== solMint)
      ? tx.postTokenBalance.mint
      : (tx.preTokenBalance?.mint && tx.preTokenBalance.mint !== solMint)
      ? tx.preTokenBalance.mint
      : 'UNKNOWN';
    const tokenDelta = Math.abs((tx.postTokenBalance?.amount || 0) - (tx.preTokenBalance?.amount || 0));

    return {
      isSwap: true,
      dex: this.dexName,
      inputTokenMint: isBuy ? 'So11111111111111111111111111111111111111112' : tokenMint,
      inputAmount: isBuy ? Math.abs(solDelta) : tokenDelta || 10,
      outputTokenMint: isBuy ? tokenMint : 'So11111111111111111111111111111111111111112',
      outputAmount: isBuy ? tokenDelta || 10 : Math.abs(solDelta),
      poolAddress: 'Meteora-DLMM-Bin',
      confidence: 0.96,
    };
  }

  calculateInput(tx: RawSolanaTransaction) { return null; }
  calculateOutput(tx: RawSolanaTransaction) { return null; }
  identifyToken(tx: RawSolanaTransaction) { return tx.postTokenBalance?.mint || null; }
  identifyExecutionPrice(inputAmount: number, outputAmount: number) { return outputAmount / Math.max(inputAmount, 0.00001); }
  identifyPool(tx: RawSolanaTransaction) { return 'Meteora-DLMM-Bin'; }
}
