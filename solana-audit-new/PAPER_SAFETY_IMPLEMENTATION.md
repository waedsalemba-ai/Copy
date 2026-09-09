# Paper Trading Safety Implementation

## Scope

The authoritative AI Studio project is the archive root. The nested `solana-audit/` directory is an older duplicate and was not used for the implementation.

## Implemented behavior

The paper-trading service now has an explicit server-side `PAPER` execution guard and contains no signer, transaction builder, or transaction broadcaster. Paper BUYs require a valid live Jupiter-derived price; if quote providers fail and no valid cached price exists, the BUY is blocked rather than filled at a fabricated price.

Source-wallet SELL events are now observation-only. They never create paper SELLs and never close user paper positions. User paper positions can close only through the paper TP/SL monitor. TP/SL exits use a single-close guard, record `TAKE_PROFIT` or `STOP_LOSS`, calculate simulated fees/slippage and realized paper PnL, and return funds only to the virtual paper account.

Paper trades and positions are marked `mode: PAPER` and include paper IDs, source event references, quote/fill fields, simulated fees/slippage, and exit reasons. Source-event checks prevent duplicate paper BUYs. Closed positions cannot be sold twice.

The UI displays a prominent paper-only warning. Reconciliation polling was reduced from 3 seconds to 15 seconds. WebSocket reconnect ownership and redundant trade-triggered REST refreshes were also corrected.

The application also includes the earlier reliability fixes: wallet-scoped public-RPC polling cursors, wallet-aware transaction processing, debounced atomic JSON persistence, production gating for destructive development endpoints, bounded API limits, webhook timeouts, and safer settings/wallet updates.

## Verification

`npm run lint` and `npm run build` pass. The production server returns HTTP 200 for health, HTTP 400 for invalid paper-trade limits, and HTTP 404 for development endpoints. Paper settings accept TP/SL configuration. The existing 24-step development acceptance suite passes when explicitly enabled with `ENABLE_DEV_ENDPOINTS=true`. A source scan of the authoritative root found no real transaction signing or broadcast APIs.

The production build still reports a large main frontend chunk; this is a performance warning and remains separate from the paper-execution safety boundary.
