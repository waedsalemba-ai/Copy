import { IDexAdapter, RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { DexProtocol } from '../../types';

export class PumpFunAdapter implements IDexAdapter {
  dexName: DexProtocol = 'Pump.fun';
  programIds: string[] = [
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun bonding curve
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap AMM
  ];

  identifyTransaction(tx: RawSolanaTransaction): boolean {
    return tx.instructions.some((ix) => this.programIds.includes(ix.programId)) ||
      Boolean(tx.logMessages?.some((log) => log.includes('6EF8rr') || log.includes('pump.fun') || log.includes('pumpswap')));
  }

  decodeSwap(tx: RawSolanaTransaction): DecodedSwapResult | null {
    if (!this.identifyTransaction(tx)) return null;

    const solDelta = tx.preSolBalance - tx.postSolBalance;
    const isBuy = solDelta > 0.0005;

    const solMint = 'So11111111111111111111111111111111111111112';
    const tokenMint = (tx.postTokenBalance?.mint && tx.postTokenBalance.mint !== solMint)
      ? tx.postTokenBalance.mint
      : (tx.preTokenBalance?.mint && tx.preTokenBalance.mint !== solMint)
      ? tx.preTokenBalance.mint
      : 'UNKNOWN';
    const tokenDelta = Math.abs((tx.postTokenBalance?.amount || 0) - (tx.preTokenBalance?.amount || 0));

    // If we can't actually see a token balance change, we don't have a real
    // trade size to report. Previously this fell back to a hardcoded 50000
    // tokens — fabricated volume presented as if it were real. Better to
    // decline to decode this one than to invent a number.
    if (tokenDelta === 0) return null;

    if (isBuy) {
      return {
        isSwap: true,
        dex: this.dexName,
        inputTokenMint: 'So11111111111111111111111111111111111111112',
        inputAmount: Math.abs(solDelta),
        outputTokenMint: tokenMint,
        outputAmount: tokenDelta,
        poolAddress: 'Pump.fun-BondingCurve',
        confidence: 0.99,
      };
    } else {
      return {
        isSwap: true,
        dex: this.dexName,
        inputTokenMint: tokenMint,
        inputAmount: tokenDelta,
        outputTokenMint: 'So11111111111111111111111111111111111111112',
        outputAmount: Math.abs(solDelta),
        poolAddress: 'Pump.fun-BondingCurve',
        confidence: 0.99,
      };
    }
  }

  calculateInput(tx: RawSolanaTransaction) { return null; }
  calculateOutput(tx: RawSolanaTransaction) { return null; }
  identifyToken(tx: RawSolanaTransaction) { return tx.postTokenBalance?.mint || null; }
  identifyExecutionPrice(inputAmount: number, outputAmount: number) { return outputAmount / Math.max(inputAmount, 0.00001); }
  identifyPool(tx: RawSolanaTransaction) { return 'Pump.fun-BondingCurve'; }
}
