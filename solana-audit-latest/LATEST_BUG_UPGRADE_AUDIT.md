# Solana Trader Wallet Monitor — Latest Version Bug and Upgrade Audit

**Audit target:** top-level project in `solana-trader-wallet-monitor(5).zip` (`/home/ubuntu/solana-audit-latest`). The archive also contains `solana-audit/` and `solana-audit-new/` copies with different source hashes. The top-level copy is treated as authoritative because it contains the largest/newest implementation, but the duplicate-root drift is itself a release risk.

## Verification summary

| Check | Result |
|---|---|
| `npm install --no-audit --no-fund` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| Production health endpoint | HTTP 200; measured locally in approximately 7 ms |
| Invalid API limits | HTTP 400 |
| Production destructive endpoint via POST | HTTP 404 |
| Development acceptance suite | 23/24 steps passed; step 3 failed twice due RPC health timeout at approximately 2.5 seconds |
| Frontend bundle | Improved to approximately 465.5 kB minified / 115.6 kB gzip for the main JS bundle |
| Real transaction execution scan | No signing or transaction submission API found; comments and paper-only code references were present |

## Prioritized findings

### Critical — strict Jupiter-only paper execution has regressed

`src/server/paperTradingService.ts:185-202` first requests `getJupiterPrice`, but then falls back to `getTokenMetadata`, and finally falls back to the observed source trade’s `executionPriceSol`. `getTokenMetadata` itself can serve cached or fallback prices, and the observed source execution price is not a current executable quote. This violates the safety contract that a paper fill must be blocked when a valid Jupiter quote is unavailable. It can create paper BUYs using stale, non-Jupiter, or source-event prices.

**Fix:** use a strict `getJupiterPrice()` result only. Remove the metadata and source execution-price fallbacks from the paper execution path. A missing, zero, stale, or invalid Jupiter quote must reject the paper BUY.

### High — paper BUY idempotency is lost after restart

`src/server/paperTradingService.ts:13,168-172` stores processed source signatures only in an in-memory `Set`. The set is lost on restart. The persisted `PaperTrade` schema contains `sourceEventId`, but `db.ts` has no lookup enforcing uniqueness before insertion. A replay or restart can create duplicate paper BUYs, duplicate virtual balance deductions, and duplicate positions.

**Fix:** add a database-level `hasPaperTradeForSourceEvent(sourceEventId, action)` check using a stable key containing wallet address plus canonical source signature/event ID. Enforce the check immediately before account mutation and trade insertion. Prefer a persisted unique execution key.

### High — public polling still misses transactions and can lose multi-wallet attribution

`src/server/laserStreamService.ts:171-178` requests only `{ limit: 2 }` signatures per wallet every 7 seconds. A wallet with more than two transactions between polls silently loses older events. `processedSignatures` at line 19 and `inFlightSignatures` at lines 20–21 are keyed only by signature. If one transaction is relevant to two monitored wallets, the second wallet can be suppressed after the first wallet claims the signature. The wallet-aware `deduplicator` is called only after the global signature checks, so it cannot repair this loss.

**Fix:** maintain a cursor per wallet, fetch a bounded but sufficient page such as 100 signatures, process unseen signatures oldest-first, and key in-flight/processed state by `walletAddress:signature`. Keep canonical transaction-fetch caching separate from wallet-specific classification.

### High — source SELL remains observation-only in closing logic but still mutates paper PnL mark price

`src/server/paperTradingService.ts:309-320` correctly avoids creating a paper SELL, but it updates the user paper position’s `currentPriceSol` from the monitored trader’s source SELL execution price. This makes the user’s paper PnL depend on a source exit event and can create misleading mark-to-market behavior. It also conflicts with the stated policy that source SELL events are observation-only.

**Fix:** do not modify the user paper position’s price, quantity, PnL, or exit state in the source SELL handler. Optionally record a separate observation metric/event that is not part of paper account valuation.

### High — TP/SL failure can leave a position permanently stuck in `PAPER_SELLING`

`src/server/paperTradingService.ts:334-388` changes the position to `PAPER_SELLING` before all calculations and persistence complete. If account update, trade persistence, or a downstream operation throws, the position can remain `PAPER_SELLING`. Subsequent refreshes skip it because line 334 returns for `PAPER_SELLING`, preventing recovery and leaving funds/positions inconsistent.

**Fix:** use a durable exit state with an error/retry path, or calculate and validate the exit before transitioning. Persist an exit ID, make account/trade/position mutation atomic as far as the storage layer allows, and recover `EXIT_PENDING`/`PAPER_SELLING` records on startup.

### High — TP/SL quote refresh is not strict Jupiter-only

`src/server/paperTradingService.ts:80` uses `rpcService.getPricesBatch()`. The batch resolves through the general metadata path, which may use DexScreener or cached fallback values. The paper TP/SL state machine therefore can exit based on a non-Jupiter or stale price even though the intended contract requires fresh Jupiter read-only quotes.

**Fix:** use a strict Jupiter-only batch method for paper mark-to-market and TP/SL decisions. If no quote is available, preserve the last mark but do not trigger an exit from a fallback value.

### Medium — API settings updates are not field-allowlisted

`server.ts:307-323` validates `webhookUrl` and `minTradeAlertValueUsd`, but then passes the entire `req.body` to `db.updateSettings(req.body)`. Clients can write unsupported fields or future internal fields. Paper settings and buy-entry settings similarly pass the full body after validating selected numeric values.

**Fix:** construct explicit allowlisted update objects before persistence. Validate URLs with the `URL` class and accept only `http:`/`https:` protocols.

### Medium — wallet creation fabricates a SOL balance when RPC is unavailable

`server.ts:161-171` uses `solBalance || 12.5`. A real zero balance and an RPC failure both become `12.5 SOL`, which is factually wrong and can mislead users and downstream logic.

**Fix:** store `0` for unavailable/zero balance, include a balance freshness/error field, or reject wallet creation when initial balance verification is required. Never fabricate a live wallet balance.

### Medium — health status reports `ok` while RPC is disconnected

`server.ts:114-121` always returns `{ status: 'ok' }` even when `rpc: false`. The local smoke test returned HTTP 200 with `rpc:false`. Monitoring systems will treat a degraded service as healthy.

**Fix:** return a status such as `degraded` when RPC or ingestion is unavailable, and use an appropriate HTTP status for readiness/health semantics. Keep a separate liveness endpoint if needed.

### Medium — WebSocket reconnect timers are not cleaned up

`src/App.tsx:72-87,222-224` schedules `setTimeout(setupWebSocket, 3000)` after every close without storing or cancelling the timer. After unmount, the timer can create a new WebSocket against an unmounted component. Repeated close events can also produce duplicate sockets and duplicated messages.

**Fix:** store the reconnect timer in a ref, track mounted state, clear the timer on unmount, and reconnect only if the closed socket is still the current socket.

### Medium — paper panel still polls every 3 seconds

`src/components/PaperTradingPanel.tsx:82-86` runs six REST requests every 3 seconds, including paper account, positions, trades, settings, buy-entry settings, and watchlist. This adds unnecessary RPC/server/Firestore pressure and duplicates the existing WebSocket event channel. The prior target was approximately 15–60 seconds with event-driven updates.

**Fix:** increase reconciliation to 15–30 seconds, abort an in-flight refresh on unmount, and subscribe to paper WebSocket events for immediate position/trade updates.

### Medium — acceptance suite has a repeatable external-RPC failure

The development suite failed twice at step 3, `User tests both connections`, with `RPC Latency: 2501ms`/`2510ms` and no slot. `rpcService.ts:341-365` uses the endpoint health check timeout of approximately 2.5 seconds and returns failure when the public endpoint does not respond in time. This may be an external public-RPC availability problem, but the suite is not resilient enough to distinguish provider outage from application regression.

**Fix:** use a dedicated deterministic mock for acceptance tests, or mark external-network checks separately from local correctness tests. Report provider timeout and endpoint name explicitly. Do not classify a network outage as a generic application failure.

### Low — duplicate project roots can cause wrong-version deployment

The archive contains top-level, `solana-audit/`, and `solana-audit-new/` projects. Their `server.ts`, `paperTradingService.ts`, `App.tsx`, and other files have different hashes. The nested copies are not harmless: an AI Studio operator or deployment script can select the wrong root and silently lose upgrades.

**Fix:** ship one project root only. If historical copies must remain, move them outside the application tree and add a root marker such as `PROJECT_ROOT.md` or a build-time assertion.

### Low — package manager metadata is inconsistent

The top-level archive contains `bun.lock` but no top-level `package-lock.json`, while nested copies contain both lock formats. Running npm install created a new top-level lockfile during this audit. This can produce dependency drift between AI Studio, local npm, and Bun environments.

**Fix:** standardize on one package manager and commit only its lockfile. Run a clean install using that package manager in CI.

## Positive upgrades confirmed

The updated top-level version includes several meaningful improvements:

- Main frontend bundle improved from approximately 971 kB minified in the previous patched copy to approximately 466 kB.
- RPC request rate limiting, endpoint cooldowns, retries, transaction caching, and in-flight request coalescing were added.
- Paper positions now have explicit `PAPER`, `EXIT_PENDING`, and `PAPER_SELLING` states.
- Paper account metrics include invested, realized, unrealized, and total paper equity values.
- API list limits and numeric paper settings have basic validation.
- Destructive development endpoints return 404 in production when called with POST.
- The source scan found no actual signer, private-key, transaction-construction, or transaction-submission path.

## Recommended fix order

1. Remove all non-Jupiter and source-price fallbacks from paper BUY and TP/SL execution.
2. Add persisted source-event idempotency and atomic paper account/position/trade mutation.
3. Fix wallet-scoped public polling cursors and signature queue keys.
4. Add recovery for failed TP/SL transitions.
5. Stop source SELL events from mutating paper valuation.
6. Fix health semantics, fabricated wallet balances, and allowlist API updates.
7. Fix WebSocket reconnect cleanup and reduce paper REST polling.
8. Collapse duplicate project roots and standardize the package manager.
9. Separate deterministic acceptance tests from external RPC availability tests.

## Conclusion

The updated version builds successfully and improves frontend bundle size, RPC resilience, and paper-state modeling. However, it is **not ready to be treated as the final paper-only safety release** because the strict-Jupiter quote requirement regressed, source-event idempotency is not persisted, public polling still drops events, and TP/SL failure recovery is incomplete. The repeatable acceptance-suite RPC failure should also be isolated from application correctness before release.
