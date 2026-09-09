/**
 * Solana Smart-Money / Trader Wallet Monitor - Shared Types
 */

export type CanonicalTradeAction =
  | 'BUY'
  | 'SELL'
  | 'UNKNOWN'
  | 'TRANSFER'
  | 'LIQUIDITY'
  | 'OTHER';

export type TradeStatus =
  | 'DETECTED'
  | 'DECODING'
  | 'CLASSIFIED'
  | 'VERIFIED'
  | 'POSITION_UPDATED'
  | 'PUBLISHED'
  | 'FAILED';

export type DexProtocol =
  | 'Jupiter'
  | 'Raydium'
  | 'Orca'
  | 'Pump.fun'
  | 'PumpSwap'
  | 'Meteora'
  | 'Unknown';

export interface CanonicalTradeEvent {
  id: string;
  walletAddress: string;
  traderName: string;
  signature: string;
  slot: number;
  blockTime: number;

  action: CanonicalTradeAction;
  status: TradeStatus;

  tokenMint: string;
  tokenSymbol: string;
  tokenDecimals: number;

  tokenAmount: number;
  solAmount: number;
  usdValue: number;

  executionPriceSol: number;
  executionPriceUsd: number;

  dex: DexProtocol;
  pool?: string;

  positionId?: string;

  timestamp: number;
  detectionLatencyMs: number;

  confidence: number;

  rawTransactionReference?: string;
  error?: string;

  // Best-effort rug/scam risk read for `tokenMint`. Populated from cache
  // synchronously when available; otherwise arrives slightly later via a
  // TOKEN_RISK_UPDATED broadcast once the background analysis finishes.
  riskAnalysis?: TokenRiskAnalysis;
}

export type TokenRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export interface TokenRiskAnalysis {
  tokenMint: string;
  level: TokenRiskLevel;
  // 0 (safest) - 100 (most dangerous)
  score: number;
  // Short human-readable warnings, worst-first, e.g. "Mint authority active"
  flags: string[];
  // Raw signals the score was derived from (undefined = could not be determined)
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  liquidityUsd?: number;
  topHolderPercent?: number;
  top10HolderPercent?: number;
  ageMinutes?: number;
  // 24h volume vs market cap: a token trading many multiples of its own
  // market cap in a day is a classic wash-trading / pump signal.
  volume24hUsd?: number;
  marketCapUsd?: number;
  volumeExceedsMarketCap?: boolean;
  // True while the background analysis for this mint is still running;
  // the row should show a "checking..." state rather than a final verdict.
  pending: boolean;
  analyzedAt: number;
  error?: string;
}

export type WalletGroup = 'Whales' | 'Smart Money' | 'Insiders' | 'Alpha' | 'Scalpers' | 'General';
export type WalletPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface TraderWallet {
  id: string;
  address: string;
  traderName: string;
  description: string;
  group: WalletGroup;
  priority: WalletPriority;
  enabled: boolean;
  solBalance: number;
  createdAt: number;
  lastActivity?: number;
  lastSignature?: string;
  alertSettings: {
    buyAlert: boolean;
    sellAlert: boolean;
    largeTradeThresholdSol: number;
  };
  metrics: {
    totalBuys: number;
    totalSells: number;
    realizedPnlSol: number;
    unrealizedPnlSol: number;
    activePositionsCount: number;
    winRatePercent: number;
    avgHoldingTimeSeconds: number;
    largestWinSol: number;
    largestLossSol: number;
  };
}

export interface Position {
  id: string;
  walletAddress: string;
  traderName: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenDecimals: number;
  
  currentQuantity: number;
  initialQuantity: number;
  averageEntryPriceSol: number;
  totalCostSol: number;
  remainingCostBasisSol: number;
  exitValueSol: number;
  
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  roiPercent: number;
  
  entryTimestamp: number;
  lastTradeTimestamp: number;
  exitTimestamp?: number;
  holdingDurationSeconds: number;
  
  buyCount: number;
  sellCount: number;
  status: 'OPEN' | 'CLOSED';
  currentPriceSol: number;
}

export type AlertType =
  | 'BUY'
  | 'SELL'
  | 'NEW_POSITION'
  | 'POSITION_CLOSED'
  | 'LARGE_TRADE'
  | 'LARGE_PNL'
  | 'NEW_TOKEN'
  | 'WALLET_ACTIVITY'
  | 'CONNECTION_FAILURE'
  | 'CONNECTION_RESTORED';

export interface SystemAlert {
  id: string;
  type: AlertType;
  title: string;
  message: string;
  traderName?: string;
  walletAddress?: string;
  signature?: string;
  timestamp: number;
  read: boolean;
  usdValue?: number;
}

export interface SystemMetrics {
  laserstreamConnected: boolean;
  laserstreamEndpoint: string;
  rpcConnected: boolean;
  rpcLatencyMs: number;
  lastSlot: number;
  lastSignature: string;
  totalTransactionsProcessed: number;
  totalTradesDetected: number;
  buyCount: number;
  sellCount: number;
  unknownCount: number;
  duplicateCount: number;
  decoderErrors: number;
  rpcErrors: number;
  avgDetectionLatencyMs: number;
  maxDetectionLatencyMs: number;
  wsClientCount: number;
  reconnectCount: number;
  activeWalletsCount: number;
}

export interface AppSettings {
  rpcUrl: string;
  laserstreamApiKey: string;
  laserstreamEndpoint: string;
  minTradeAlertValueUsd: number;
  webhookUrl?: string;
}

export interface AcceptanceTestStepResult {
  step: number;
  title: string;
  status: 'PASS' | 'FAIL' | 'PENDING';
  detail: string;
  timestamp: number;
}

export interface AcceptanceTestReport {
  timestamp: number;
  passed: boolean;
  steps: AcceptanceTestStepResult[];
}

export interface CopyTradeSettings {
  enabled: boolean;
  fixedSolAmountPerTrade: number;
  simulatedSlippageBps: number;
  startingVirtualSolBalance: number;
  takeProfitPercent: number;
  stopLossPercent: number;
}

export interface PaperPosition {
  id: string;
  sourceWalletAddress: string;
  traderName: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenDecimals: number;

  quantity: number;
  costBasisSol: number;
  avgEntryPriceSol: number;
  currentPriceSol: number;

  realizedPnlSol: number;
  unrealizedPnlSol: number;
  roiPercent: number;

  // Shadow-tracks the real trader's held quantity for this token, computed
  // purely from the same trade events we mirror (buys add, sells subtract).
  // Used only to work out what fraction of OUR paper position to sell when
  // the trader sells some or all of theirs — never a real balance.
  traderQuantityShadow: number;

  entryTimestamp: number;
  lastTradeTimestamp: number;
  exitTimestamp?: number;
  status: 'OPEN' | 'CLOSED';
  mode?: 'PAPER';
  tradeId?: string;
  sourceEventId?: string;
  takeProfitPercent?: number;
  stopLossPercent?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  exitReason?: 'TAKE_PROFIT' | 'STOP_LOSS';
}

export interface PaperTrade {
  id: string;
  sourceWalletAddress: string;
  traderName: string;
  sourceSignature: string;
  tokenMint: string;
  tokenSymbol: string;
  action: 'BUY' | 'SELL';
  tokenAmount: number;
  solAmount: number;
  executionPriceSol: number;
  // 1.0 for a buy (always a fixed-size entry); the fraction of the trader's
  // own sell that this mirrors, for a sell.
  mirrorRatio: number;
  timestamp: number;
  mode?: 'PAPER';
  paperTradeId?: string;
  sourceEventId?: string;
  reason?: 'PAPER_BUY' | 'TAKE_PROFIT' | 'STOP_LOSS';
  quotedPrice?: number;
  simulatedFeesSol?: number;
  simulatedSlippageBps?: number;
  priceImpactPct?: number;
}

export interface PaperAccount {
  virtualSolBalance: number;
  startingVirtualSolBalance: number;
  totalRealizedPnlSol: number;
}

export interface BuyEntrySettings {
  enabled: boolean;
  // Gate 8 / Gate 7 threshold from the spec.
  minMomentumScoreToBuy: number;
  // Gate 1's "Risk/Rug Check = PASS" maps to riskAnalysisService's LOW/MEDIUM/
  // HIGH/CRITICAL levels — this is the worst level still considered a pass.
  maxAcceptableRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  // Dev-holding % isn't reliably computable from free data sources (see
  // buyEntryEngine.ts). Off by default so Gate 1 doesn't hard-fail on data
  // we don't actually have.
  requireDevHoldingCheck: boolean;
  // How long a WATCH/READY_TO_BUY candidate stays queued for re-evaluation
  // before it's dropped (the trader's own buy simply isn't mirrored).
  watchWindowMinutes: number;
}

export interface BuyEntryVerdict {
  tokenMint: string;
  tokenSymbol: string;
  verdict: 'REJECT' | 'WATCH' | 'READY_TO_BUY' | 'BUY';
  momentumScore: number;
  reasons: string[];
  dataGaps: string[];
  evaluatedAt: number;
}
