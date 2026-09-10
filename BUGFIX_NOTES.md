# Bug & bottleneck fixes

Applied on top of the existing `/src` + `server.ts` app (the duplicate
`solana-audit*` folders and the stale nested zip from the original upload
were left out of this package — they weren't part of the running app).

## Bugs

1. **`minTradeAlertValueUsd` was never enforced.** `alertEngine.ts` now
   suppresses BUY/SELL alerts below the configured USD threshold
   (`src/server/alertEngine.ts`).
2. **Hardcoded SOL/USD price.** `config.solPriceUsd` was a fixed constant
   used for every USD figure in the app. `rpcService` now keeps a live
   SOL/USD rate refreshed in the background (`getSolPriceUsd()`), which
   `classifier.ts` and the DexScreener/Jupiter fallback paths use instead.
   The config constant remains only as the last-resort fallback before the
   first live read lands.
3. **Race condition in paper-trading buy execution.** `executeMirroredBuy`
   checked "existing open position?" / "enough balance?" before an `await`
   on a price quote, so two BUY events for the same wallet+token close
   together could both pass stale checks and double-open a position /
   double-spend the virtual balance. Added a per-wallet+token in-flight
   lock, and moved the signature-dedup marker before the first `await`.
4. **`buyEntryEngine.processWatchlist()` had no re-entrancy guard.** A large
   watchlist could take longer than the 30s tick to process (each candidate
   does an awaited network fetch), letting the next tick start a second
   overlapping pass and double-resolve the same token. Added an
   `isProcessingWatchlist` guard, matching the pattern already used
   elsewhere (`laserStreamService`'s `isProcessingQueue`/`isPolling`).

## Bottlenecks

5. **Synchronous full-DB rewrite blocked the event loop.** `db.ts` now
   writes with `fs.promises.writeFile` instead of `fs.writeFileSync`, with a
   simple in-flight/pending flag so concurrent saves collapse into one
   rewrite instead of piling up. (The one-time initial write at startup
   stays synchronous — harmless before the server is accepting traffic.)
6. **Unbounded `positions` / `paperPositions` growth.** Both arrays grew
   forever (unlike `trades`, `alerts`, `paperTrades`, which were already
   capped). Added `trimClosedPositions()` / `trimClosedPaperPositions()`,
   capping CLOSED entries at 1000 each while never touching OPEN ones.
   Directly shrinks the payload behind fix #5, too.
7. **Several unbounded in-memory caches (slow memory leaks):**
   - `rpcService.staticMetaCache` / `priceCache` — capped at 3000 mints,
     oldest evicted.
   - `riskAnalysisService.cache` — capped at 3000 mints, oldest evicted.
   - `buyEntryEngine.history` — capped at 500 mints, oldest evicted.
   - `paperTradingService.processedSourceSignatures` — now self-trims past
     10,000 entries, matching the existing pattern in `alertEngine`'s
     `alertedSignatures` and `deduplicator`'s `processedKeys`.
8. **Serialized TP/SL exits blocked the price-refresh loop.**
   `paperTradingService.refreshOpenPositionPrices` no longer `await`s a
   triggered `executePaperSellExit` inline — it fires in the background so
   one slow exit (including its own live quote fetch) doesn't delay
   refreshing every other open position in the same tick.
9. **HTTP polling fallback scaled linearly with wallet count.**
   `laserStreamService.pollWallets()` polled monitored wallets one at a
   time with a fixed 200ms gap between each; past ~30 wallets a single pass
   no longer finished inside the 7s poll interval. It now fans all wallets
   out via `Promise.allSettled` and relies on `rpcService`'s existing
   central rate limiter (max 2 concurrent RPC calls, 150ms spacing) for
   throttling, instead of serializing wallet-by-wallet.

None of these change external API/behavior contracts — same endpoints,
same response shapes, same UI. `npm run lint` (`tsc --noEmit`) should be
run after `npm install` to confirm the type-check, since this sandbox had
no network access to install dependencies and verify compilation directly.
