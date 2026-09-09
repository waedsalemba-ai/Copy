/**
 * Paper Execution Safety Guard
 * 
 * MANDATORY SAFETY BOUNDARY:
 * This application is PAPER TRADING ONLY.
 * 
 * - Active execution mode is strictly defined as `PAPER`.
 * - No transaction signers, private keys, wallet signers, or RPC broadcasters exist.
 * - No live swap endpoints or transaction builders are invoked.
 * - `assertPaperExecution()` MUST be called before every paper trade execution.
 */

export type ExecutionMode = 'PAPER';

export const EXECUTION_MODE: ExecutionMode = 'PAPER';

export function assertPaperExecution(): void {
  if (EXECUTION_MODE !== 'PAPER') {
    throw new Error('[SAFETY GUARD REJECTED] Live execution is permanently disabled. Mode must be PAPER.');
  }
}
