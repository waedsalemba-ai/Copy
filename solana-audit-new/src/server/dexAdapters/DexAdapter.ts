import { DexProtocol } from '../../types';

export interface RawSolanaInstruction {
  programId: string;
  data?: string;
  keys?: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
}

export interface RawSolanaTransaction {
  signature: string;
  slot: number;
  blockTime: number;
  walletAddress: string;
  instructions: RawSolanaInstruction[];
  innerInstructions?: Array<{
    index: number;
    instructions: RawSolanaInstruction[];
  }>;
  preSolBalance: number;
  postSolBalance: number;
  preTokenBalance?: { mint: string; amount: number; decimals: number };
  postTokenBalance?: { mint: string; amount: number; decimals: number };
  logMessages?: string[];
}

export interface DecodedSwapResult {
  isSwap: boolean;
  dex: DexProtocol;
  inputTokenMint: string;
  inputAmount: number;
  outputTokenMint: string;
  outputAmount: number;
  poolAddress?: string;
  confidence: number;
}

export interface IDexAdapter {
  dexName: DexProtocol;
  programIds: string[];

  identifyTransaction(tx: RawSolanaTransaction): boolean;
  decodeSwap(tx: RawSolanaTransaction): DecodedSwapResult | null;
  calculateInput(tx: RawSolanaTransaction): { mint: string; amount: number } | null;
  calculateOutput(tx: RawSolanaTransaction): { mint: string; amount: number } | null;
  identifyToken(tx: RawSolanaTransaction): string | null;
  identifyExecutionPrice(inputAmount: number, outputAmount: number): number;
  identifyPool(tx: RawSolanaTransaction): string | null;
}
