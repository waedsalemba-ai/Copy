import { PaperTrade } from '../types';

/**
 * Paper mode is the only execution mode implemented by this application.
 * This guard is intentionally service-side, not a UI toggle: there is no
 * signer, swap transaction builder, or transaction broadcaster in this path.
 */
export const PAPER_EXECUTION_MODE = 'PAPER' as const;

export function assertPaperExecution(): void {
  if (PAPER_EXECUTION_MODE !== 'PAPER') {
    throw new Error('Paper execution rejected: execution mode is not PAPER');
  }
}

export function createPaperTradeId(action: PaperTrade['action']): string {
  return `PAPER-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
