import {
  CanonicalTradeEvent,
  CanonicalTradeAction,
  TradeStatus,
} from '../types';
import { RawSolanaTransaction } from './dexAdapters/DexAdapter';
import { dexRegistry } from './dexAdapters/DexRegistry';
import { rpcService } from './rpcService';
import { db } from './db';
import { riskAnalysisService } from './riskAnalysisService';

export class TradeClassifier {
  public async classifyTransaction(
    tx: RawSolanaTransaction
  ): Promise<CanonicalTradeEvent> {
    const startTime = Date.now();
    const wallet = db.getWalletByAddress(tx.walletAddress);
    const traderName = wallet
      ? wallet.traderName
      : tx.walletAddress.length > 8
      ? `Trader ${tx.walletAddress.slice(0, 4)}...${tx.walletAddress.slice(-4)}`
      : tx.walletAddress;

    // Step 1: Check DEX Registry for Swap Decoding
    const swap = dexRegistry.decodeTransaction(tx);

    let action: CanonicalTradeAction = 'UNKNOWN';
    let confidence = 0.5;
    let tokenMint = 'UNKNOWN';
    let tokenSymbol = 'UNKNOWN';
    let tokenDecimals = 6;
    let tokenAmount = 0;
    let solAmount = 0;
    let executionPriceSol = 0;
    let dex = swap ? swap.dex : 'Unknown';

    const solMint = 'So11111111111111111111111111111111111111112';

    // Normalize SOL balances if passed in lamports (> 1e6)
    let preSol = tx.preSolBalance;
    let postSol = tx.postSolBalance;
    if (preSol > 1e6 || postSol > 1e6) {
      preSol /= 1e9;
      postSol /= 1e9;
    }

    if (swap && swap.isSwap) {
      confidence = swap.confidence;
      if (swap.inputTokenMint === solMint) {
        // Spent SOL to get Token => BUY
        action = 'BUY';
        solAmount = swap.inputAmount > 1e6 ? swap.inputAmount / 1e9 : swap.inputAmount;
        tokenMint = swap.outputTokenMint;
        tokenAmount = swap.outputAmount;
      } else if (swap.outputTokenMint === solMint) {
        // Sold Token to get SOL => SELL
        action = 'SELL';
        tokenMint = swap.inputTokenMint;
        tokenAmount = swap.inputAmount;
        solAmount = swap.outputAmount > 1e6 ? swap.outputAmount / 1e9 : swap.outputAmount;
      } else {
        // Token for Token swap
        const isSpentSol = preSol > postSol;
        action = isSpentSol ? 'BUY' : 'SELL';
        tokenMint = isSpentSol ? swap.outputTokenMint : swap.inputTokenMint;
        tokenAmount = isSpentSol ? swap.outputAmount : swap.inputAmount;
        solAmount = Math.abs(preSol - postSol);
      }
    } else {
      // Analyze raw balance deltas
      const solDelta = postSol - preSol;
      const hasTokenChange = Boolean(tx.preTokenBalance || tx.postTokenBalance);
      const tokenChangeAmt = Math.abs(
        (tx.postTokenBalance?.amount || 0) - (tx.preTokenBalance?.amount || 0)
      );

      if (hasTokenChange && tokenChangeAmt > 0 && Math.abs(solDelta) > 0.0005) {
        // Token and SOL changed in opposite directions => SWAP
        const isBuy = solDelta < 0; // Spent SOL to acquire token
        action = isBuy ? 'BUY' : 'SELL';
        confidence = 0.75;
        tokenMint = tx.postTokenBalance?.mint || tx.preTokenBalance?.mint || 'UNKNOWN';
        tokenAmount = tokenChangeAmt;
        solAmount = Math.abs(solDelta);
      } else if (hasTokenChange && Math.abs(solDelta) < 0.0005) {
        // SPL Token transfer without SOL trade => TRANSFER
        action = 'TRANSFER';
        confidence = 0.9;
        tokenMint = tx.postTokenBalance?.mint || tx.preTokenBalance?.mint || 'UNKNOWN';
        tokenAmount = tokenChangeAmt;
      } else if (!hasTokenChange && Math.abs(solDelta) > 0.001) {
        // Plain SOL transfer => TRANSFER
        action = 'TRANSFER';
        confidence = 0.95;
        tokenMint = solMint;
        solAmount = Math.abs(solDelta);
      } else {
        // Uncertain or insufficient info => UNKNOWN
        action = 'UNKNOWN';
        confidence = 0.3;
        tokenMint = tx.postTokenBalance?.mint || tx.preTokenBalance?.mint || 'UNKNOWN';
      }
    }

    // Resolve token metadata asynchronously / from cache
    if (tokenMint !== 'UNKNOWN') {
      const meta = await rpcService.getTokenMetadata(tokenMint);
      tokenSymbol = meta.symbol;
      // The raw transaction's own token balance entries carry the mint's
      // real decimals (as reported by the chain for this specific account).
      // Prefer that over the metadata cache's hardcoded fallback (6),
      // which is wrong for the many SPL tokens that use 9 or another value.
      const rawDecimals = tx.postTokenBalance?.decimals ?? tx.preTokenBalance?.decimals;
      tokenDecimals = rawDecimals ?? meta.decimals ?? 6;
    }

    // NOTE: tokenAmount is expected to already be in UI (decimal-adjusted)
    // units by the time it reaches here (that's the convention the DEX
    // adapters and raw-balance-delta path both follow). A previous "raw
    // atomic units" auto-normalization heuristic (tokenAmount > 1e8) was
    // removed: many legitimate memecoin trades involve UI amounts well
    // above 1e8 (huge token supplies), and the heuristic would silently
    // divide those down by 10^decimals, corrupting real trade sizes.

    // Calculate execution price
    if (tokenAmount > 0 && solAmount > 0) {
      executionPriceSol = solAmount / tokenAmount;
    }

    // Live SOL/USD rate (kept fresh in the background by rpcService),
    // rather than the fixed benchmark constant in config, which would
    // otherwise drift from the real market price over time.
    const solPriceUsd = rpcService.getSolPriceUsd();
    const usdValue = solAmount * solPriceUsd;
    const executionPriceUsd = executionPriceSol * solPriceUsd;

    // Detection latency: actual wall-clock time between the transaction's
    // on-chain blockTime and when we finished classifying it. This used to
    // be `Math.random() * 45` clamped into a fixed [15, 650] window — a
    // fabricated number dressed up as a real observability metric,
    // regardless of how the pipeline was actually performing. `blockTime`
    // only has 1-second resolution, so this is approximate, but it's real.
    const currentMs = Date.now();
    const txTimeMs = tx.blockTime ? tx.blockTime * 1000 : currentMs;
    const detectionLatencyMs = Math.max(0, currentMs - txTimeMs);

    // Create normalized Canonical Trade Event
    const uniqueSuffix = `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const event: CanonicalTradeEvent = {
      id: `trade_${tx.signature.slice(0, 12)}_${tx.slot}_${uniqueSuffix}`,
      walletAddress: tx.walletAddress,
      traderName,
      signature: tx.signature,
      slot: tx.slot,
      blockTime: tx.blockTime || Math.floor(Date.now() / 1000),
      action,
      status: action === 'UNKNOWN' ? 'FAILED' : 'CLASSIFIED',
      tokenMint,
      tokenSymbol,
      tokenDecimals,
      tokenAmount,
      solAmount,
      usdValue,
      executionPriceSol,
      executionPriceUsd,
      dex,
      pool: swap?.poolAddress,
      timestamp: currentMs,
      detectionLatencyMs,
      confidence,
      rawTransactionReference: `slot:${tx.slot},ix:${tx.instructions.length}`,
      // Cache-first, non-blocking: returns instantly (cached / pending
      // placeholder) and kicks off a background refresh if needed. The
      // resolved read for THIS mint arrives shortly after via a
      // TOKEN_RISK_UPDATED broadcast for every open BUY/SELL row on it.
      riskAnalysis:
        action === 'BUY' || action === 'SELL'
          ? riskAnalysisService.getOrRefresh(tokenMint)
          : undefined,
    };

    return event;
  }
}

export const tradeClassifier = new TradeClassifier();
