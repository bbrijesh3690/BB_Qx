# BB_Qx progress

The single source of truth for where the build stands. Update it in the same commit as the work it describes, and push.

## If a session hits its usage limit

Nothing is lost: every agent commits and pushes its branch as it goes, and each branch carries a checklist at `progress/<branch-name>.md`.

To resume after the limit resets, open a Claude Code session in `E:\Qx\BB_Qx` and say:

> Continue BB_Qx from PROGRESS.md.

The lead then:
1. Reads this file and `git branch -a`.
2. For each branch listed under "Active work" that isn't merged, reads its `progress/*.md` checklist and relaunches an agent on that branch to finish only the unchecked items.
3. Merges finished branches, runs `npm run check`, pushes, and updates this file.

## Current state

- **Phase:** 0 (feed and ledger), with phase 1 engines started early on synthetic data only
- **Wave:** 1 of phase 0 is merged and integrated; the first live recording (12 min, 2026-10-22) confirmed the schema.
- **Last updated:** 2026-10-22
- **Next:** the owner reloads the extension, opens each of the 5+ target assets once in one Quotex window (3+ OTC, 2 live), then leaves it running 24 h. After that: export the dataset, replay it with `npm run harness -- --dataset <file>`, and do the 50-candle spot-check.

## Active work (wave 1, parallel)

| Branch | Agent | Scope | Status |
| --- | --- | --- | --- |
| `wave1/extension` | Feed + extension | MV3 manifest, WebSocket interception, raw-frame recorder, Quotex frame decoder, IndexedDB ledger, minimal panel, dataset export, build script | **merged** into main 2026-10-22 (122 tests green, `npm run build:ext` OK) |
| `wave1/core-harness` | Core + harness | rng, time, tunables, candle builder, pipeline (freeze at T-5s, scoring), in-memory ledger, ledger conformance suite, null engine, 4 synthetic generators, harness runner and CLI, evidence regression tests | **merged** into main 2026-10-22 (resumed once after a usage limit; no work lost) |
| `wave1/engines` | Engines | Feature library (one per indicator family), feed-structure engine, price action engine | **merged** into main 2026-10-22 (65 tests green) |

## Phase 0 checklist

- [x] Repository, contracts and resume files (lead)
- [x] Wave 1 branches merged into `main`
- [x] Pipeline wired into the extension service worker (lead): null, feed-structure and price-action engines run live; on worker restart, engine state, the last 1,005 minutes of candles and the latest payout are reloaded from the ledger
- [x] `npm run check` green; harness replays a synthetic day deterministically; the IndexedDB ledger passes the same 38-test conformance suite as the in-memory one
- [x] Extension loads in Chrome without errors (owner, 2026-10-22)
- [x] Raw recording reviewed (12 min, 8,976 frames); decoder mapping confirmed against real frames. The first load ran the pre-integration build (recording started 17:20 IST, integrated build 17:23), so it showed ticks but 0 candles; replaying the recording through the core built candles correctly.
- [x] History backfill: each asset open fills up to about an hour of closed minutes from Quotex's own history, and completes the first partial candle
- [ ] **Gate (amended 2026-10-22 by the owner):** 24 h of candles per asset **in total across sessions** on 5 assets (3 OTC), every gap logged; 50-candle colour spot-check; null engine scored on all; a recorded day replays deterministically

## What the first recording showed (2026-10-22)

- Socket: `wss://ws2.quotex.com/socket.io/?EIO=3&transport=websocket`, Socket.IO v2 with binary attachments (`451-` header, then a binary frame starting 0x04).
- `quotes/stream` rows are `[assetId, serverSeconds (fractional), price, flag]`, about 140 per minute per asset. Server time is about 0.3 s behind the local clock.
- `instruments/list` rows are `[id, assetId, displayName, type, ?, payoutPercent, ...]`. Payout (index 5) matches the number Quotex shows and changes every few minutes (BRL/USD went 90 → 92 → 91 → 85 → 86 → 88 → 90 in 12 minutes).
- Quotex's ids aren't always its display names: `BRLUSD_otc` is shown as "USD/BRL (OTC)". Prices (about 0.194) follow the id. The panel now shows the display name, with the id in a tooltip.
- An asset streams from the moment it is opened once in the page and keeps streaming after switching away (11 assets in one window during the second run). So one window covers the 5-asset gate.
- Each time an asset is opened, the page receives about 60 minutes of its tick history: about 10 minutes in `history/list/v2`, then 50 minutes in `history/load` (the page asks for `offset: 3000` s at chart period 15 s). `candles` is empty at that period. Not used yet; it could backfill gaps of up to an hour before each reopen and shorten warmup. Untested: whether a longer chart period (1m or 5m) makes the page ask for more history.
- History arrives only for the asset being opened (or switched back to), not for every open asset. USD/PKR got only the 11-minute `history/list/v2` batch, no `history/load`. Untested: whether scrolling an asset's chart back makes the page load older history (expected to arrive as more `history/load` chunks, which backfill can now join).
- Proposed collection routine (owner, 2026-10-22): visit every few hours and reopen each asset, letting backfill fill the gap. It works for candles and ticks if the history reaches back over the whole gap. Live running is still needed for payouts (history carries none) and for the live shadow votes the definition of done asks for.
- The owner reports that Quotex reloads the page and closes assets by itself, so a continuous unattended 24 h run isn't realistic. Possible causes to check: Chrome Memory Saver discarding the background tab, PC sleep, Quotex's own reconnects. The ledger logs every gap (`feed_gap`) and every worker reload.
- Everything else on the socket is account data (balance, orders, trade history, settings). It is no longer stored (see decisions).

## Phase 1 (next)

Scoreboard counters, stacker with signal rule and kill switch, panel with votes, p and rolling accuracy beside the null engine with n. Feed-structure and price action engines are already in wave 1; they get their harness results on all four synthetic feeds after merge.

Wave 1 engine results (engines agent's own fixture generator, not yet the core harness):
- Feed-structure labels at a 1000-candle window: random walk 2.7% false labels in total; bounded k = 0.08 called mean-reverting in 90.6% of windows; k = 0.2 in 100%; trending (drift 0.1 sigma) called trending in 63.8%. A long-horizon variance ratio (q = 16) does the work: lag-1 autocorrelation alone catches k = 0.08 in only 12.7% of windows.
- Price action over 3 x 20,000 candles per feed: random walk votes on 0.3% of candles (n = 159, inside noise); bounded k = 0.08: 55.7% (n = 9,788, 95% CI 54.7-56.7); k = 0.2: 61.2% (n = 8,932); trending: 54.0% (n = 19,425), the ceiling for that drift and below break-even at 85%.

Follow-ups for wave 2 (lead):
- Price action reads closed candles only and ignores `ctx.forming`, so at T-5s it predicts two candles ahead of its newest data. Try the forming candle as a provisional close and measure it against the flip rate.
- `EngineStats.abstains` can't be counted inside an engine (`vote()` is pure, abstains get no outcome). The phase 1 scoreboard, computed from the ledger, is the source of truth for counters.
- `FeedStructure` has no trend sign; consider adding a signed drift field in phase 1.
- Consolidate `src/engines/stats-tracker.ts` with the null engine's tracker; register the engines' and the extension's TUNABLEs in `src/core/tunables.ts`.

Integration (done 2026-10-22):
- `src/extension/background/sink.ts`: `createPipelineSink` is the runtime sink. `createDirectSink` stays for feed-processor tests.
- The first candle per asset after a page load or worker restart is dropped when its first tick came more than 3 s after its open (`partialStartToleranceMs`). Otherwise its open and colour would be wrong. The feed's own candle for that minute is still used when one exists.
- Conformance choices accepted as the contract's meaning: `listSignals` filters on `ts`; votes with the same candleOpenTs sort by voteId; event seq starts at 1; `engine_stats` export puts numeric buckets before `'all'`; ticks are pruned at `now - 2h`.
- `npm run analyze-frames -- <raw.ndjson> --dataset out.ndjson` builds a full-recording dataset from raw frames (the ledger keeps only 2 h of ticks).

Harness results, wave 1 engines (seed 2, 20,000 candles per asset, 2 OTC + 2 live assets, `npm run harness -- --source <feed> --candles 20000 --seed 2 --engines feed-structure,price-action`):

| Feed | Null OTC / live | Price action OTC | Price action live |
| --- | --- | --- | --- |
| random walk | 50.1% / 49.9% (n ≈ 39,300 each) | votes on 0.6% of candles; 49.3% (n = 223), building sample | 50.8% (n = 236), building sample |
| bounded k = 0.08 | 50.0% / 50.0% | 55.7% (n = 6,689, 95% CI 54.5-56.9) | 56.0% (n = 6,705, CI 54.8-57.2) |
| trending | 50.3% / 49.9% | 56.3% (n = 23,002, CI 55.6-56.9) | 56.2% (n = 23,343, CI 55.6-56.9) |
| regime switching | 50.1% / 50.0% | 55.1% (n = 8,498, CI 54.0-56.2) | 53.6% (n = 7,518, CI 52.4-54.7) |

These are synthetic feeds with the structure built in; they show the engines can find structure when it exists and stay at 50% when it doesn't. They say nothing yet about Quotex.

Still open from integration:
- `stats-tracker.ts` (engines) and the null engine's tracker are still separate; consolidate in phase 1 with the scoreboard.
- The extension's and engines' TUNABLEs are marked in code but not yet listed in `src/core/tunables.ts`.
- Engine `reload` events use the local clock for `ts` (the server offset isn't known yet at worker start).
- A harness run with feed-structure takes about 2 minutes per 20,000-candle feed; fine for now.

## Decisions log

- 2026-10-22: A vote predicts the next candle (the one opening at the current candle's close), frozen at T-5s and scored at that candle's close: WIN, LOSS, or TIE when close equals open.
- 2026-10-22: Recording multiple assets: one Chrome window per asset; the recorder tags frames by tab. If the raw feed turns out to carry other assets too, one window may be enough.
- 2026-10-22: Stack: TypeScript, esbuild for the extension bundles, Vitest, fake-indexeddb for IndexedDB tests, MV3 with a MAIN-world content script for interception.
- 2026-10-22: Owner trades at `https://quotex.com/en/demo-trade`. Shadow running starts on the demo account. Payouts on demo may differ from a real account, so the payout recorded with each vote is whatever the demo page shows; check this before comparing against real-account break-even.
- 2026-10-22: Privacy: raw frames keep full payloads only for market events (`MARKET_EVENTS` in `src/extension/quotex/redact.ts`). Other events keep only their name; unpaired binary attachments are dropped whole. Raw frames stored under the old policy are deleted on the first start of the new build. Checked against the real recording: market data decodes identically, and no account data is left.
- 2026-10-22: Raw recorder runs 1 h (cap 500k frames) instead of 24 h. The schema is mapped, and raw frames cost about 27 MB/hour. Ticks are kept 26 h instead of BB_Qx.md's 2 h, so a recorded day can be exported and replayed (about 100 MB for 5 assets). Revisit after the phase 0 gate.
- 2026-10-22: Binary attachments are paired per direction. The page's own outgoing frames can fall between an incoming header and its attachment; one shared assembler lost 6 frames in the first recording.
- 2026-10-22: Phase 0 gate counts 24 h of candles per asset in total across sessions, not one continuous run (owner's decision: Quotex reloads the page and closes assets on its own).
- 2026-10-22: History backfill. New `MarketEvent` kind `history` (lead contract change): the decoder turns `history/list/v2` and `history/load` ticks into one event per batch. The candle builder builds a 'rebuilt' candle for every closed minute it lacks that the history covers from start to end (within 3 s). Built minutes leave memory at once; only ticks of minutes cut by a batch boundary wait (up to 48 h, 20k ticks per asset) for the neighbouring chunk, so history loaded by scrolling a chart back for hours still joins up. It completes a partial first live candle from them, never replaces a candle it already has, and backfilled minutes never vote. On the first recording: candles 12 → 71 (BRL/USD), 4 → 65 (NZD/CAD), 1 → 59 (USD/ARS), 1 → 57 (USD/IDR), 8 → 18 (USD/PKR, which got no `history/load`). In the 10 BRL/USD minutes covered by both live and history ticks, OHLC matched exactly.
- 2026-10-22: Engines get a seed through `EngineFactory` so a harness run is fully determined by (source, engines, seed).

## Open questions for the owner

0. ~~Phase 0 gate with gaps~~ Decided 2026-10-22 (owner): 24 h of candles per asset **in total across sessions**, every gap logged. History backfill: built. Pending: the owner's 5m-chart test to see whether a longer chart period brings more history.

1. ~~Exact URL of the Quotex trading page~~ Answered 2026-10-22: `https://quotex.com/en/demo-trade` (demo account). Covered by the manifest's `https://quotex.com/*` match; quotex.io and qxbroker.com stay in the list as harmless extras.
2. The 7 open questions at the end of BB_Qx.md; defaults are in use until answered.
3. Pattern-discovery validation rule (phase 2): the rule as written validated 3 to 18 patterns per 20,000 coin-flip candles in a quick simulation; a 3-sigma lower bound on window-B accuracy validated none. The bounded k = 0.08 feed's 53.3% edge is below p* at 85% payout (54.1%), which conflicts with the definition of done.
