# wave1/core-harness progress

Branch: `wave1/core-harness`. Owner: core + harness agent. Tick each item in the same commit as the work, then push.

- [ ] 1. Core helpers: src/core/rng.ts, time.ts, stats.ts, tunables.ts
- [ ] 2. In-memory ledger (src/ledger/memory.ts) and conformance suite (src/ledger/conformance.ts, memory.test.ts)
- [ ] 3. Candle builder (src/core/candles.ts)
- [ ] 4. Pipeline (src/core/pipeline.ts)
- [ ] 5. Null engine (src/engines/null.ts)
- [ ] 6. Synthetic generators (src/harness/generators.ts)
- [ ] 7. Harness: sources.ts, run.ts, registry.ts, cli.ts
- [ ] 8a. Tests: determinism (synthetic and recorded replay)
- [ ] 8b. Tests: pipeline (freeze, no look-ahead, scoring, ties, gaps, warmup, throwing engine)
- [ ] 8c. Tests: null engine on 20,000 random-walk candles
- [ ] 8d. Tests: evidence regressions (pattern mining, indicator correlation, feed structure, power calc)
- [ ] 8e. Tests: determinism guard (no Date.now / Math.random / performance.now)
