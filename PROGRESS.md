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
- **Wave:** 1 of phase 0
- **Last updated:** 2026-10-22

## Active work (wave 1, parallel)

| Branch | Agent | Scope | Status |
| --- | --- | --- | --- |
| `wave1/extension` | Feed + extension | MV3 manifest, WebSocket interception, raw-frame recorder, Quotex frame decoder, IndexedDB ledger, minimal panel, dataset export, build script | started |
| `wave1/core-harness` | Core + harness | rng, time, tunables, candle builder, pipeline (freeze at T-5s, scoring), in-memory ledger, ledger conformance suite, null engine, 4 synthetic generators, harness runner and CLI, evidence regression tests | started |
| `wave1/engines` | Engines | Feature library (one per indicator family), feed-structure engine, price action engine | **merged** into main 2026-10-22 (65 tests green) |

## Phase 0 checklist

- [x] Repository, contracts and resume files (lead)
- [ ] Wave 1 branches merged into `main`
- [ ] Pipeline wired into the extension service worker (lead)
- [ ] `npm run check` green; harness replays a synthetic day deterministically
- [ ] Extension loads in Chrome without errors (owner)
- [ ] One-hour raw recording reviewed; decoder mapping confirmed against real frames
- [ ] **Gate:** 24 h of candles and ticks on 5 assets (3 OTC); 50-candle colour spot-check; null engine scored on all; recorded day replays deterministically

## Phase 1 (next)

Scoreboard counters, stacker with signal rule and kill switch, panel with votes, p and rolling accuracy beside the null engine with n. Feed-structure and price action engines are already in wave 1; they get their harness results on all four synthetic feeds after merge.

Wave 1 engine results (engines agent's own fixture generator, not yet the core harness):
- Feed-structure labels at a 1000-candle window: random walk 2.7% false labels in total; bounded k = 0.08 called mean-reverting in 90.6% of windows; k = 0.2 in 100%; trending (drift 0.1 sigma) called trending in 63.8%. A long-horizon variance ratio (q = 16) does the work: lag-1 autocorrelation alone catches k = 0.08 in only 12.7% of windows.
- Price action over 3 x 20,000 candles per feed: random walk votes on 0.3% of candles (n = 159, inside noise); bounded k = 0.08: 55.7% (n = 9,788, 95% CI 54.7-56.7); k = 0.2: 61.2% (n = 8,932); trending: 54.0% (n = 19,425), the ceiling for that drift and below break-even at 85%.

Follow-ups for wave 2 (lead):
- Price action reads closed candles only and ignores `ctx.forming`, so at T-5s it predicts two candles ahead of its newest data. Try the forming candle as a provisional close and measure it against the flip rate.
- `EngineStats.abstains` can't be counted inside an engine (`vote()` is pure, abstains get no outcome). The phase 1 scoreboard, computed from the ledger, is the source of truth for counters.
- `FeedStructure` has no trend sign; consider adding a signed drift field in phase 1.
- Consolidate `src/engines/stats-tracker.ts` with the null engine's tracker; register the engines' TUNABLEs in `src/core/tunables.ts`.

## Decisions log

- 2026-10-22: A vote predicts the next candle (the one opening at the current candle's close), frozen at T-5s and scored at that candle's close: WIN, LOSS, or TIE when close equals open.
- 2026-10-22: Recording multiple assets: one Chrome window per asset; the recorder tags frames by tab. If the raw feed turns out to carry other assets too, one window may be enough.
- 2026-10-22: Stack: TypeScript, esbuild for the extension bundles, Vitest, fake-indexeddb for IndexedDB tests, MV3 with a MAIN-world content script for interception.
- 2026-10-22: Owner trades at `https://quotex.com/en/demo-trade`. Shadow running starts on the demo account. Payouts on demo may differ from a real account, so the payout recorded with each vote is whatever the demo page shows; check this before comparing against real-account break-even.
- 2026-10-22: Engines get a seed through `EngineFactory` so a harness run is fully determined by (source, engines, seed).

## Open questions for the owner

1. ~~Exact URL of the Quotex trading page~~ Answered 2026-10-22: `https://quotex.com/en/demo-trade` (demo account). Covered by the manifest's `https://quotex.com/*` match; quotex.io and qxbroker.com stay in the list as harmless extras.
2. The 7 open questions at the end of BB_Qx.md; defaults are in use until answered.
3. Pattern-discovery validation rule (phase 2): the rule as written validated 3 to 18 patterns per 20,000 coin-flip candles in a quick simulation; a 3-sigma lower bound on window-B accuracy validated none. The bounded k = 0.08 feed's 53.3% edge is below p* at 85% payout (54.1%), which conflicts with the definition of done.
