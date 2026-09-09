# Solana Trader Wallet Monitor — Bug and Latency Audit

**Audit date:** 2026-09-08

## Executive summary

The application **typechecks, builds, starts, and passes its built-in 24-step acceptance suite**. Warm local API smoke tests returned HTTP 200 in approximately **2–10 ms**. The main risks are production correctness and scalability rather than compilation failures.

The two most urgent issues are:

1. The public-RPC polling fallback can **silently miss transactions**.
2. The ingestion path performs multiple **synchronous full-file JSON rewrites**, which can block the Node.js event loop and inflate latency during activity bursts.

## Verification

| Check | Result |
|---|---|
| `npm run lint` | Passed |
| `npm run build` | Passed |
| Production server startup | Passed on port 3100 |
| Health, metrics, trades, positions, and paper-account endpoints | HTTP 200 |
| Built-in acceptance suite | Passed, all 24 steps |
| Production bundle | ~971 kB minified, ~249 kB gzip; Vite emitted a chunk-size warning |

## High-priority findings

### 1. Public-RPC polling permanently misses transactions — High

**Evidence:** `src/server/laserStreamService.ts:152–193` polls each wallet every seven seconds with `getSignaturesForAddress(..., { limit: 2 })`. It does not paginate with `before` or retain a per-wallet last-seen cursor.

**Impact:** A wallet producing more than two transactions between polls can have older transactions omitted forever. Trades, positions, alerts, and paper-trading state then become incomplete without an obvious error.

**Fix:** Maintain a durable cursor per wallet, page backward until the cursor is reached, process new signatures oldest-first, and add tests for burst traffic. A reliable provider/websocket should be preferred over polling where available.

### 2. Global signature deduplication drops multi-wallet observations — High

**Evidence:** `src/server/laserStreamService.ts:19,176–183` uses one `Set<string>` keyed only by transaction signature.

**Impact:** A transaction involving two monitored wallets is processed for the first wallet encountered and skipped for the second, even though classification is wallet-specific. Per-wallet trade counts and positions can be wrong.

**Fix:** Use wallet-plus-signature keys for observation deduplication, or separate transaction-fetch caching from wallet-specific classification. The existing `Deduplicator` already includes the wallet address in its key.

### 3. Synchronous full-store writes block the event loop — High

**Evidence:** `src/server/db.ts:150–163` calls `writeFileSync` after pretty-printing the entire store. `updateMetrics` at lines 321–325 also saves on every update. A single ingestion path updates metrics, positions, trades, and alerts several times (`src/server/laserStreamService.ts:326–372`).

The supplied `data/store.json` is approximately **1.5 MB**. `savePosition`, `addTrade`, and `addAlert` also rewrite it synchronously.

**Impact:** Each event can cause multiple blocking disk writes and repeated JSON serialization. Under bursts, this delays HTTP responses, WebSocket broadcasts, polling cycles, and subsequent transaction processing.

**Fix:** Add an asynchronous persistence queue with debounce/batching and atomic temp-file replacement. Do not persist high-frequency metrics on every update. For production volume, move event data to SQLite/Postgres/Firestore with indexes.

### 4. Destructive development endpoints are exposed in production — High

**Evidence:** `server.ts:358–374` exposes `/api/dev/run-test` and `/api/dev/clear-data` without authentication or an environment guard.

**Impact:** Any reachable caller can run tests that mutate data or clear wallets, trades, positions, and alerts.

**Fix:** Register these routes only under an explicit development flag, or protect them with authorization. Remove `/api/dev/clear-data` from production entirely.

## Medium-priority latency and correctness findings

### 5. Public polling is serial across wallets and transactions — Medium/High

**Evidence:** `src/server/laserStreamService.ts:170–184` awaits each wallet request and each transaction fetch sequentially.

**Impact:** Poll duration grows with wallet count and RPC latency. If a poll exceeds seven seconds, the `isPolling` guard skips the next interval, increasing detection delay.

**Fix:** Use bounded concurrency for wallet signature requests and transaction fetches while preserving per-wallet ordering.

### 6. WebSocket reconnects can create stale or duplicate connections — Medium/High

**Evidence:** `src/App.tsx:115–215` schedules a new reconnect timer on every close, but does not retain/clear the timer or verify that the closing socket is still the active socket.

**Impact:** Stale sockets can reconnect after a newer socket exists, causing duplicate messages, duplicate refreshes, and extra server load.

**Fix:** Track one reconnect timer, cancel it during cleanup, use an active-socket check, and add exponential backoff with jitter.

### 7. Trade events trigger redundant REST requests — Medium

**Evidence:** `src/App.tsx:139–161` fetches both positions and wallets after each trade even though position and wallet events are broadcast separately. `server.ts:106–109` broadcasts metrics every three seconds regardless of changes.

**Impact:** Active trading creates two extra requests per browser per trade, while idle clients still receive periodic metric updates.

**Fix:** Apply WebSocket payloads directly, refetch after reconnect or suspected event loss, and throttle/coalesce metrics broadcasts.

### 8. Paper-trading UI polls six endpoints every three seconds — Medium

**Evidence:** `src/components/PaperTradingPanel.tsx:45–74` performs six requests on mount and every three seconds while the tab is active.

**Impact:** This creates avoidable request and serialization load even though paper position/trade events already exist on the server event bus.

**Fix:** Push paper updates through WebSocket events and retain only a slower reconciliation fetch, such as every 30–60 seconds or on reconnect.

### 9. Webhook requests lack timeout and SSRF controls — Medium

**Evidence:** `src/server/alertEngine.ts:92–106` calls `fetch(settings.webhookUrl, ...)` without an abort timeout or URL policy.

**Impact:** A slow endpoint can retain resources. If arbitrary URLs are accepted, the server may be used to reach internal services.

**Fix:** Require `http`/`https`, consider an allowlist, add an `AbortController` timeout, and use a bounded delivery queue.

### 10. API limits are not bounded — Medium

**Evidence:** `server.ts:235–248` and `262–265` pass parsed `limit` values through without finite/minimum/maximum validation.

**Impact:** Invalid or very large limits can create surprising responses or unnecessary memory/serialization work.

**Fix:** Normalize limits to a safe range such as `1–500` and reject invalid values with HTTP 400.

### 11. Browser bundle is oversized — Medium

**Evidence:** Vite emitted a ~971 kB minified JavaScript asset.

**Impact:** Increased download, parse, and startup time, especially on mobile.

**Fix:** Lazy-load tab views using `React.lazy`, split Firebase/Solana-heavy dependencies, and configure Rollup manual chunks.

## Additional observations

- `server.ts:113–120` reports `laserstreamConnected` even when the service intentionally falls back to HTTP polling for public RPC (`laserStreamService.ts:101–106`). Expose separate stream and polling states.
- `db.clearAllData()` at `src/server/db.ts:327–334` resets database arrays but does not clear the live service's monitored-wallet set, subscriptions, or polling state. Clear-data should coordinate with the stream service.
- `POST /api/wallets` performs an RPC balance lookup before adding the wallet (`server.ts:148–202`) without a visible timeout or controlled error response.
- `riskAnalysisService.ts:76–80` races timeout promises but does not abort the underlying RPC request, allowing timed-out work to continue.

## Recommended order of work

1. Gate or remove `/api/dev/*`, and validate query/settings inputs.
2. Implement per-wallet polling cursors and wallet-aware deduplication.
3. Replace synchronous hot-path JSON writes with batched asynchronous persistence.
4. Fix WebSocket ownership/reconnect cleanup and remove redundant REST refreshes.
5. Add bounded polling concurrency, webhook timeouts/SSRF controls, and frontend code splitting.

## Bottom line

The application is operational in the tested environment, but it should **not be used for high-value or high-volume wallet monitoring** until the polling cursor/deduplication issues and synchronous full-store persistence are fixed. Those issues can cause missed trades and materially increase latency even while basic local API checks remain fast.

*End of report.*
