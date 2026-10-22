# BB_Qx (Quorum)

Chrome MV3 extension for Quotex that runs a committee of engines voting on next-candle direction, scores every vote against a coin-flip null engine, and stays in shadow mode. The full spec is [BB_Qx.md](BB_Qx.md); read it before changing anything.

## Start of every session

1. Read [PROGRESS.md](PROGRESS.md). It says which phase and wave we are in, which branches hold unfinished work, and what to do next.
2. Run `git status`, `git log --oneline -15` and `git branch -a` to confirm the state matches PROGRESS.md.
3. Continue from the first unchecked item in PROGRESS.md. Don't restart finished work.

## Keep local and GitHub in sync

Remote: https://github.com/bbrijesh3690/BB_Qx (branch `main`). Commit and push after every finished piece of work, and update PROGRESS.md in the same commit. Work branches are pushed too, so nothing lives only on one machine.

## Rules that never bend (from BB_Qx.md)

- No order-placement code, no martingale, no indicator as a voter. Indicators are features only.
- The extension sends nothing back to the platform in v1. It only reads frames the page already receives.
- Every percentage is shown with its n. No edge claim below n = 600 scored votes per engine per asset class.
- Break-even is p* = 1 / (1 + payout); signals need max(p, 1 - p) >= p* + margin.
- Core, engine, feature, harness and in-memory ledger code is deterministic: no `Date.now()`, `Math.random()` or `performance.now()`. Use `src/core/rng.ts`.
- Assumed numbers are marked `// TUNABLE` and registered in `src/core/tunables.ts`.

## Layout and ownership

| Path | Owner |
| --- | --- |
| `src/core/contracts.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `CLAUDE.md`, `PROGRESS.md`, `BB_Qx.md` | Lead only |
| `src/core/**` (candles, pipeline, rng, time, tunables), `src/ledger/memory.ts`, `src/ledger/conformance.ts`, `src/engines/null.ts`, `src/harness/**`, `tests/evidence/**` | Core + harness |
| `src/extension/**`, `src/ledger/indexeddb.ts`, `scripts/**` | Feed + extension |
| `src/features/**`, `src/engines/**` except `null.ts` | Engines |

## Commands

- `npm run check`: typecheck and run every test
- `npm run build:ext`: build the unpacked extension into `dist/extension`
- `npm run harness -- --help`: replay recorded or synthetic data through the pipeline
