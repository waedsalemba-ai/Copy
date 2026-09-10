import { RawSolanaTransaction, DecodedSwapResult } from './DexAdapter';
import { BaseDexAdapter, SOL_MINT } from './BaseDexAdapter';
import { DexProtocol } from '../../types';

export class PumpFunAdapter extends BaseDexAdapter {
  dexName: DexProtocol = 'Pump.fun';
  programIds: string[] = [
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun bonding curve
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap AMM
  ];

  override identifyTransaction(tx: RawSolanaTransaction): boolean {
    return super.identifyTransaction(tx) ||
      Boolean(tx.logMessages?.some((log) => log.includes('6EF8rr') || log.includes('pump.fun') || log.includes('pumpswap')));
  }

  decodeSwap(tx: RawSolanaTransaction): DecodedSwapResult | null {
    if (!this.identifyTransaction(tx)) return null;

    const solDelta = tx.preSolBalance - tx.postSolBalance;
    const isBuy = solDelta > 0.0005;

    const tokenMint = (tx.postTokenBalance?.mint && tx.postTokenBalance.mint !== SOL_MINT)
      ? tx.postTokenBalance.mint
      : (tx.preTokenBalance?.mint && tx.preTokenBalance.mint !== SOL_MINT)
      ? tx.preTokenBalance.mint
      : 'UNKNOWN';
    const tokenDelta = Math.abs((tx.postTokenBalance?.amount || 0) - (tx.preTokenBalance?.amount || 0));

    // If we can't actually see a token balance change, decline to decode.
    if (tokenDelta === 0) return null;

    if (isBuy) {
      return {
        isSwap: true,
        dex: this.dexName,
        inputTokenMint: SOL_MINT,
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
        outputTokenMint: SOL_MINT,
        outputAmount: Math.abs(solDelta),
        poolAddress: 'Pump.fun-BondingCurve',
        confidence: 0.99,
      };
    }
  }

  override identifyPool(_tx: RawSolanaTransaction): string {
    return 'Pump.fun-BondingCurve';
  }
}

