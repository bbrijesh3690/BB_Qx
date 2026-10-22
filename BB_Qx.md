# BB\_Qx Build Brief

Oct 22, 2026 · @Yash Soni

This is the opening prompt for a multi-agent Claude session that builds Quorum (codename BB\_Qx): a Chrome extension for Quotex that runs a committee of engines predicting next-candle direction on OTC and live pairs, scores every vote against a coin flip, and stays in shadow mode until the scoreboard proves an edge. Paste everything below as the first message of the build session; the builder reads it end to end before writing code.

## Mission and rules

Build Quorum (codename BB\_Qx): a Chrome extension (Manifest V3) that runs on quotex.io, reads the candle and tick data the page already receives, runs a committee of engines that each vote on the next candle's direction, combines the votes through a verifier that is trained on realized outcomes, and shows votes, confidence and running accuracy in an on-page panel. It targets OTC assets and live pairs equally. Version 1 places no trades: it is a shadow-mode evidence system whose job is to find out, per asset, whether any engine has an edge, and to say so only with the sample size to back it.

**Name.** The extension ships as **Quorum**; BB\_Qx stays the codename for the repository and project. A quorum is the minimum number of votes a decision needs before it counts, which is the verifier's rule in one word, and it says nothing about profit, which suits a tool whose job is to find out whether an edge exists. Before any public listing, check the Chrome Web Store and GitHub for name clashes; unrelated software companies already use the word.

Success is a scoreboard the owner can trust, not a high number. A system that reports 50% on a random feed and abstains on most candles is working; one that reports 65% after forty votes is not.

Rules the builder follows throughout:

- A null engine (coin flip) runs alongside every voter. A voter earns weight only by beating it on scored votes.
- Every percentage is reported with its sample size n. No claim of edge before 600 scored votes per engine per asset class (see Verifier rules).
- The signal threshold comes from the payout, never from a fixed number: break-even p\* = 1 / (1 + payout). 80% payout needs 55.6%, 85% needs 54.1%, 90% needs 52.6%, 93% needs 51.8%.
- ABSTAIN and NO TRADE are first-class outputs. Expect most candles to end in NO TRADE.
- All statistics are kept per asset, per OTC/live class and per session bucket (hour of day). Nothing is pooled across assets by default.
- Indicators are features, never separate voters (see Evidence).
- No martingale, anywhere, ever. No order-placement code in v1.
- Everything persists in IndexedDB and survives reloads; the ledger of votes and outcomes exports to CSV/JSON.
- When in doubt, build the measurement first and the cleverness second.

## Evidence from exploration

Four small simulations run during the design conversation shaped the architecture. The builder treats them as settled and does not re-litigate them; the QA agent re-runs them in the replay harness as regression tests.

| Experiment | Setup | Result | Design consequence |
| --- | --- | --- | --- |
| Pattern mining on noise | 20,000 pure coin-flip candles; mine colour sequences of length 2–7 with n ≥ 30 and in-sample accuracy ≥ 58% | 27 "patterns" found in-sample; same patterns averaged 49.9% out-of-sample (range 42–57%) | Pattern discovery must validate out-of-sample, across days, with n ≥ 100, and expire on decay. Most candidates should die. |
| Indicator correlation | RSI, Stochastic, Williams %R, CCI, EMA 9–21, MACD on the same 1-minute random-walk candles | Stoch vs Williams %R = 1.00; RSI/Stoch/CCI 0.80–0.92; EMA-cross vs MACD 0.98 | Six indicators carry two pieces of information (range position, short-term drift). One feature per family, folded into price action; never an indicator-confluence voter. |
| Synthetic feed structure | Pure random walk vs a generator that pulls price gently toward an anchor (k = 0.08) | Random walk: lag-1 autocorrelation −0.004, fade-after-3-streak 49.8%. Bounded generator: autocorrelation −0.038, fade-after-3-streak 53.3% | A synthetic (OTC) feed can carry measurable structure that a real market lacks; a feed-structure engine can detect it. 53% still loses at 85% payout, so asset and payout selection matter as much as direction. |
| Sample size | Binomial power calculation, one-sided, 5% significance, 80% power | About 600 scored votes to tell 55% from 50% | No edge claim below n = 600 per engine per asset class; a hot week proves nothing. |

## Architecture

&#91;embedded content: BB\_Qx architecture · data layer, engine committee, verifier, scoreboard\]

Candles and ticks flow down from the data layer; the five direction voters and the null engine vote on every candle, the context engines decide which assets and horizons they vote on, the gates can only veto or raise the bar, and the verifier turns the votes into SIGNAL or NO TRADE. Every vote is scored at candle close, and the scoreboard feeds those outcomes back into the engines and the verifier; the null engine is a coin flip and sets the bar each voter must beat.

## Engine roster

Fourteen components in four groups. Only the five direction voters say UP or DOWN; the context and gate engines shape when and where those votes count; the baseline and judge decide what becomes a signal. Every component implements the same Engine contract (see Data layer and interfaces) so the verifier, scoreboard and replay harness treat them alike.

| # | Engine | Group | Inputs | Output | OTC vs live | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Price action | Direction voter | Closed candles; features: band position (Bollinger 20/2), wick-to-body ratios, range-vs-trend regime, one oscillator (RSI 14), EMA 9/21 slope, 5m and 15m regime from the same feed | UP / DOWN / ABSTAIN + confidence + reasons | Both | Hand-coded rules with tunable thresholds, not ML. Interpretable: every vote carries the rule that fired. |
| 2 | Candlestick | Direction voter | Last 1–3 closed candles: engulfing, pin bar, doji, inside bar, three soldiers/crows, morning/evening star | Vote + confidence | Both; expect weak on live sub-5m, unknown on OTC | Do not disable on OTC: a generator can produce these shapes for non-psychological reasons. Let the scoreboard decide. |
| 3 | Pattern discovery | Direction voter | Colour sequences of the last 2–7 closed candles (G-R-G-R, 2R-2G, ...) per asset | Vote only from validated patterns; otherwise ABSTAIN | Both | Self-learning, under the validation protocol in Verifier rules. Candidate → validated → expired lifecycle visible in the panel. |
| 4 | Tick engine | Direction voter | Tick stream of the forming candle: price position within the candle at T−15s to T−5s, direction flips, acceleration into the close | Vote + confidence | Both | The only voter that sees the present candle. Decision is frozen at T−5s. |
| 5 | Cross-asset | Direction voter | Returns of correlated pairs (e.g. GBP/USD vs EUR/USD) over the last 1–5 candles | Vote + confidence | Live only; phase 4 | Lead/lag between real pairs. Needs a second feed; skipped on OTC. |
| 6 | Feed-structure | Context | Rolling window (200–1,000 candles) per asset: lag-1..k autocorrelation of returns, variance ratio, runs test, streak-reversal rate | Label (mean-reverting / trending / none) + strength | Both; decisive on OTC | Reverse-engineers the generator. Feeds priors to engines 1–3 and the scanner. Re-computed every candle. |
| 7 | Opportunity scanner | Context | All open assets: payout %, feed-structure strength, volatility regime, session bucket | Ranked list of assets worth running voters on | Both | Payout alone moves break-even from 55.6% (80%) to 51.8% (93%). Worth more than any direction engine. |
| 8 | Timing / expiry | Context | Feed-structure label, volatility, tick-engine state | Horizon (1m / 2m / 5m) and entry second | Both | Mean reversion after a streak suits one-candle expiry; a detected trend suits longer. |
| 9 | Gatekeeper | Gate | ATR / band width / candle-size vs 20-candle average, minute after a spike, session opens, news minutes (live) | TRADE / NO-TRADE | Both | Volatility family of indicators lives here. Skip anything volume-based: Quotex exposes no real volume. |
| 10 | End-of-candle flip | Gate | Per asset: rate at which the final 1–3 seconds reverse the candle colour | Flip rate; raises the confidence bar or forces NO-TRADE | Both | Execution risk, not prediction. Measured, never assumed. |
| 11 | Drift watchdog | Gate | Each engine's accuracy stream; feed-structure statistics | Regime-change alarm per asset | Both | Page-Hinkley or ADWIN. On alarm: fast-decay stacker weights, expire validated patterns, reset rolling windows. |
| 12 | Null engine | Baseline | Seeded RNG | UP / DOWN at random, confidence 0.5 | Both | The bar every voter must beat. Scored exactly like the others. |
| 13 | Verifier / stacker | Judge | Every engine's signed confidence, gate flags, payout, feed label | p(UP); SIGNAL UP / SIGNAL DOWN / NO TRADE | Both | Online logistic regression, not majority vote. Fires only when max(p, 1−p) ≥ p\*(payout) + margin. |
| 14 | Risk policy | Judge | Verifier p, payout, ledger | Stake size (shadow: recorded, not placed), daily stop state | Both | Flat or quarter-Kelly, capped. Shadow mode in v1. |

## Verifier, scoreboard and validation rules

The verifier is a stacker trained on realized outcomes, the scoreboard is the ground truth it learns from, and the validation protocol decides which self-discovered patterns are allowed to vote at all. These rules are not tunable by engines; they sit above them.

**Scoreboard (the ledger).** Every vote from every engine, including the null engine, is written before the candle closes with a server timestamp, and scored at close as WIN, LOSS or TIE. Counters are kept per engine × asset × OTC/live × session bucket (hour of day): votes, abstains, hits, rolling accuracy over the last 100 and 200 scored votes, all-time accuracy, and a Brier score for calibration. Nothing is ever deleted; windows are computed over the ledger.

**Stacker.** Features per candle: each direction engine's signed confidence (+c for UP, −c for DOWN, 0 for ABSTAIN), the gate flags, the feed-structure label as one-hot, and the payout. Model: online logistic regression updated by SGD after every scored outcome, learning rate 0.01–0.05, L2 regularisation, with exponential recency decay (half-life about 300 votes). One model per asset class (OTC / live) at first; per asset once an asset has 600 scored votes. Output: p(UP), calibrated.

**Signal rule.** SIGNAL fires only when max(p, 1 − p) ≥ p\*(payout) + margin, with p\* = 1 / (1 + payout) and margin 0.02 by default. Anything else is NO TRADE. The gatekeeper and flip engine can only raise the bar or veto; they never lower it.

**Why not majority vote.** Engines 1–3 read the same closed candles, so their votes are correlated; three correlated voters agreeing on noise is still noise. The stacker learns the correlation through its weights; a majority vote cannot.

**Kill switch.** An engine whose rolling 200-vote accuracy on an asset falls below the null engine's gets weight zero on that asset until it beats the null engine over the next 200 scored votes. The panel shows the kill state.

**Minimum evidence.** No engine or asset is described as having an edge below n = 600 scored votes. Below that, the panel shows the number with a "building sample" label. Percentages are never shown without n.

**Pattern-discovery protocol (engine 3).** Candidates are colour sequences of length 2–7 per asset. A candidate becomes validated only when all of these hold: at least 100 occurrences; discovered on window A and confirmed on a disjoint later window B with accuracy ≥ p\*(typical payout for that asset) in B; occurrences spread across at least 3 distinct days; direction consistent in A and B. A validated pattern votes with confidence equal to its B-window accuracy, shrunk toward 0.5 by n. It expires when its live rolling accuracy over 100 occurrences falls below the null engine, or when the drift watchdog alarms on that asset. Expired patterns can be re-validated from scratch. The panel shows candidate, validated and expired counts per asset; a healthy system has many candidates and few validated.

**Drift watchdog (engine 11).** Page-Hinkley (or ADWIN) on each engine's hit/miss stream and on the feed-structure autocorrelation series. On alarm for an asset: halve the stacker's effective sample for that asset, expire its validated patterns, reset rolling windows, and log the event. The QA agent proves this fires on a synthetic regime switch and stays quiet on a stationary feed.

## Data layer and interfaces

The first thing built is a recorder, because nothing else can be tested without it. The chart on quotex.io is a canvas, so DOM scraping of candles is not viable; the data arrives over the page's own WebSocket (socket.io-style frames). A content script injects a page-context script that wraps `WebSocket.prototype.send` and the `message` event, forwards frames to the extension, and the recorder logs raw frames for 24 hours so the feed agent can map the schema (asset ids, tick messages, candle messages, payout updates, server time). The extension reads only data the page already delivers to the user's browser; it sends nothing back to the platform in v1.

**Candle building.** Candles are rebuilt from ticks using server timestamps, never the local clock, and reconciled against any candle messages the feed provides. Candle boundaries come from server time modulo the timeframe. Decisions are frozen at T−5s before close; the frozen vote carries that timestamp. Outcomes are scored at close plus a short confirmation delay, from the close price the feed reports, not from the panel's own reconstruction. TIE (close equals open) is recorded separately and handled per the platform's rule (see Open questions).

**IndexedDB stores.**

| Store | Key | Fields | Retention |
| --- | --- | --- | --- |
| candles | asset + tf + openTs | open, high, low, close, tickCount, source (feed / rebuilt) | 30 days, then thinned to 5m |
| ticks | asset + ts | price | ring buffer, last 2 hours per asset |
| votes | voteId | ts, asset, isOTC, tf, engine, direction, confidence, reasons, features, payoutAtVote, frozenAt | forever |
| outcomes | voteId | result (WIN / LOSS / TIE), closePrice, scoredAt | forever |
| signals | signalId | ts, asset, p, direction, stakeShadow, gateFlags, engineWeights | forever |
| patterns | asset + key | status (candidate / validated / expired), occurrences, winsA, winsB, days, firstSeen, lastSeen, validatedAt, expiredAt | forever |
| engine\_stats | engine + asset + bucket | votes, abstains, hits, ties, last100, last200, brier, killed | forever, recomputable from votes + outcomes |
| payouts | asset + ts | percent | 30 days |
| feed\_structure | asset + ts | label, strength, autocorr\[1..5\], varianceRatio, runsZ, streakReversalRate | 30 days |
| events | ts | kind (drift alarm, kill, unkill, pattern validated / expired, reload), payload | forever |

**Engine contract.** Every component, including the null engine and the verifier, implements this interface so the scoreboard, panel and replay harness need no special cases.

```ts
type Direction = 'UP' | 'DOWN' | 'ABSTAIN';
type Outcome = 'WIN' | 'LOSS' | 'TIE';

interface Candle { openTs: number; open: number; high: number; low: number; close: number; tickCount: number }
interface Tick { ts: number; price: number }
interface FeedStructure { label: 'mean-reverting' | 'trending' | 'none'; strength: number; autocorr: number[]; varianceRatio: number; runsZ: number; streakReversalRate: number }
interface SessionInfo { hourUtc: number; dayOfWeek: number; isOTC: boolean; marketOpen: boolean }

interface Context {
  asset: string; isOTC: boolean; tf: '1m' | '2m' | '5m';
  candles: Candle[];            // closed candles, oldest first
  forming: Candle | null;       // the candle in progress
  ticks: Tick[];                // ticks of the forming candle
  now: number;                  // server time
  candleCloseAt: number;        // server time of the next close
  feed: FeedStructure; payout: number; session: SessionInfo;
}

interface Vote {
  engine: string; direction: Direction;
  confidence: number;           // 0.5..1.0; 0.5 means no opinion
  reasons: string[];            // human-readable, shown in the panel
  features?: Record<string, number>;
}

interface EngineStats { votes: number; abstains: number; hits: number; ties: number; last100: number | null; last200: number | null; brier: number | null; killed: boolean }

interface Engine {
  id: string;
  kind: 'direction' | 'context' | 'gate' | 'baseline' | 'judge';
  warmupCandles: number;        // ABSTAIN until this many closed candles exist
  vote(ctx: Context): Vote;     // pure: no side effects, no I/O
  onOutcome(vote: Vote, outcome: Outcome, ctx: Context): void;  // learning happens here
  stats(asset: string): EngineStats;
  serialize(): unknown;         // persisted to IndexedDB after every outcome
  restore(state: unknown): void;
}
```

**Replay harness.** A deterministic runner that feeds recorded or synthetic candles and ticks through the whole pipeline with a seeded RNG, produces the same ledger every run, and is the only way engines are evaluated during development. Synthetic generators required: pure random walk, bounded (anchor-pulling, k configurable), trending (drift), regime-switching (alternates the above on a schedule). Live Quotex data is for shadow running, not for development loops.

## Risk and execution policy

Version 1 is shadow mode: the extension records what it would have staked and never touches the trade buttons. There is no order-placement code in the repository until phase 4, and even then it sits behind an explicit opt-in, a dry-run flag that defaults to on, and a per-session confirmation.

- **Stake sizing (shadow, recorded per signal):** flat 1% of a nominal balance, or quarter-Kelly f = 0.25 × (p × (1 + b) − 1) / b where b is the payout and p the verifier's calibrated probability; capped at 2%. Both are recorded so the two policies can be compared on the same ledger.
- **Stops:** a daily shadow drawdown of 5% or three consecutive losing signals on one asset pauses that asset for the session; the event is logged and shown.
- **Never martingale.** No stake depends on the previous result. The code review checklist includes this line.
- **Abstain is success.** The panel shows the NO TRADE rate; a healthy system sits well above 70%.
- **Execution risk:** the end-of-candle flip engine's rate is applied as an extra margin on top of p\*. If the flip rate on an asset exceeds 20%, that asset is NO TRADE regardless of p.
- **Ties:** recorded as their own outcome and excluded from accuracy; the shadow stake treats a tie per the platform rule once confirmed (refund or loss).
- **Legal and terms:** before any live stake, confirm the legal status of binary options and of this platform in the owner's jurisdiction, and read the platform's terms on automation. Shadow-first is partly for that reason; the builder flags this once, in the first status report, and does not decide it.

## Build order

Five phases, each with a gate that must pass before the next begins. The measurement layer comes first in every phase; an engine is never added before the thing that would catch it being wrong.

1. **Phase 0 — Feed and ledger.** WebSocket interception and raw-frame recorder; schema mapping; candle builder with server-time boundaries; IndexedDB stores; null engine; minimal panel showing candle counts per asset; replay harness with the four synthetic generators. Gate: 24 hours of recorded candles and ticks on at least 5 assets including 3 OTC; rebuilt candles match the chart's colours on a manual spot-check of 50 candles; null engine scored on all of them; the harness replays a recorded day and a synthetic day deterministically.
2. **Phase 1 — Scoreboard, verifier and the first voter.** Scoreboard counters per engine × asset × bucket; stacker with signal rule and kill switch; feed-structure engine; price action engine; panel shows votes, p, SIGNAL / NO TRADE, each engine's rolling accuracy beside the null engine, with n. Gate: on pure random synthetic data every engine and the verifier report 50% within noise and the verifier fires on fewer than 5% of candles; on bounded synthetic data the feed-structure engine labels mean-reverting and price action climbs above the null engine; 600 shadow votes scored on live Quotex data.
3. **Phase 2 — Learning voters and gates.** Candlestick engine; pattern discovery with the full validation protocol; tick engine; gatekeeper. Gate: the pattern lifecycle (candidate → validated → expired) is visible per asset and, on random synthetic data, validates nothing over a 20,000-candle run; the tick engine's accuracy is reported separately for T−15s, T−10s and T−5s decision points.
4. **Phase 3 — Selection, timing and self-defence.** Opportunity scanner; timing / expiry engine; end-of-candle flip engine; drift watchdog; risk policy with shadow stakes and stops; ledger export to CSV / JSON. Gate: the watchdog alarms within 300 candles of a synthetic regime switch and stays silent on a stationary feed; the scanner's ranking changes with payout; the exported ledger reproduces every panel number offline.
5. **Phase 4 — Cross-asset and optional execution.** Cross-asset engine on live pairs; order placement behind opt-in and dry-run, only if the owner asks for it. Gate: at least two weeks of continuous shadow running with the verifier above break-even at n ≥ 600 on at least one asset class, reported with confidence intervals; the owner's explicit go-ahead.

## Agent split

Seven agents, one lead. The lead owns this brief, the interfaces and integration, and is the only agent that merges. The QA agent is independent: it never reads an engine's claims before testing it, and its verdict on a gate is final. Agents work in parallel inside a phase and hand off through the three contracts at the end of this section.

| Agent | Owns | Delivers | Depends on |
| --- | --- | --- | --- |
| Lead / architect | This brief, repository layout, the Engine, Ledger and Harness contracts, code review, phase gates, status reports to the owner | Integrated extension per phase; a status report after every gate with every number carrying its n | Everyone |
| Feed | WebSocket interception, raw recorder, schema mapping, candle builder, server-time sync, payout capture, IndexedDB layer | Working feed on quotex.io; recorded datasets; Ledger API | Nothing (starts first) |
| Core | Scoreboard, null engine, verifier / stacker, signal rule, kill switch, drift watchdog, risk policy | The judge layer and its tests on synthetic data | Feed (Ledger API), Harness |
| Engines A | Price action, candlestick, feed-structure, gatekeeper | Four engines against the contract, each with harness results on all four synthetic feeds | Harness, Engine contract |
| Engines B | Pattern discovery with validation protocol, tick engine, timing / expiry, end-of-candle flip, opportunity scanner | Five engines against the contract, same evidence | Harness, Engine contract, Feed (ticks) |
| UI | On-page panel in a shadow DOM, settings, per-asset views, pattern lifecycle view, event log, ledger export / import | Panel that shows every number the scoreboard holds, with n, and nothing it does not | Core (scoreboard shape) |
| QA / evaluation | Replay harness, the four synthetic generators, regression tests for the four experiments in Evidence, gate verification, adversarial review of every engine | Pass / fail per gate with reproduction commands; a written list of every place an engine could be fooling itself | Nothing; builds the harness in phase 0 alongside Feed |

**Contracts.** Three interfaces are frozen by the lead in phase 0 and changed only by the lead:

- **Engine contract** — the TypeScript interface in Data layer and interfaces. `vote()` is pure; learning happens only in `onOutcome()`; state round-trips through `serialize()` / `restore()`.
- **Ledger API** — append-only writes for votes, outcomes, signals and events; read queries by engine × asset × bucket × window; one implementation over IndexedDB for the extension and one in-memory for the harness, behaviourally identical.
- **Harness contract** — `run(source, engines, seed) → ledger`, where `source` is a recorded dataset or a synthetic generator with parameters; identical inputs produce an identical ledger, byte for byte.

**Working rules for all agents.** Report percentages with n. Prefer a measured number over an assumed one; when a number must be assumed (a threshold, a half-life), mark it `// TUNABLE` and register it in settings. Every engine ships with its harness results on all four synthetic feeds in its pull request. No agent adds an indicator as a voter, a martingale, or trade-placement code; if a task seems to need one of these, it goes back to the lead.

## Definition of done and open questions

BB\_Qx v1 is done when all of the following hold, verified by the QA agent and reported with reproduction steps:

- [ ] Runs on quotex.io without console errors across a full session on at least 5 assets, 3 of them OTC.
- [ ] Every engine in the roster except cross-asset is implemented against the Engine contract and has harness results on all four synthetic feeds.
- [ ] On pure random synthetic data, every engine and the verifier report 50% within noise, pattern discovery validates nothing, and the verifier fires on fewer than 5% of candles.
- [ ] On bounded synthetic data, feed-structure labels mean-reverting and at least price action and pattern discovery beat the null engine at n ≥ 600.
- [ ] The drift watchdog alarms on a regime-switching feed and stays silent on a stationary one.
- [ ] The panel shows, per asset: every engine's vote and reasons, the verifier's p and signal state, rolling accuracy beside the null engine with n, kill state, feed-structure label, flip rate, pattern lifecycle counts, NO TRADE rate, and the event log.
- [ ] The ledger exports to CSV / JSON and the exported file reproduces every panel number offline.
- [ ] 600 or more shadow votes per engine have been scored on live Quotex data, and the first status report states, with confidence intervals, which assets show structure and which look like coin flips.
- [ ] No trade has been placed and no order-placement code exists in the repository.

**Open questions for Yash** (the builder asks these in its first message and proceeds with the stated default until answered):

1. Feed access: the recorder in phase 0 will reveal the WebSocket schema; if the platform obfuscates it, the fallback is reading the platform's own in-page state. Default: WebSocket interception first.
2. Assets to start with: which 5 assets (3 OTC, 2 live) should the first shadow run cover? Default: the highest-payout OTC pairs open at the time plus EUR/USD and GBP/USD.
3. Tie rule: on this platform, does close equal to open refund the stake or count as a loss? Default: recorded separately, treated as a loss in shadow P&L.
4. Payout source: payouts change through the day; confirm they are readable from the page. Default: scraped from the asset panel on each candle.
5. Timeframes: 1-minute only in v1, or 1m plus 5m from the start? Default: 1m, with 5m and 15m computed as context only.
6. Execution: should phase 4 include order placement at all? Default: no; shadow only until asked.
7. Repository and stack: TypeScript, Vite or similar bundler, Manifest V3, Vitest for the harness. Default: yes to all unless Yash prefers otherwise.
