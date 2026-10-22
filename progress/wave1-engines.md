# wave1/engines progress

Branch `wave1/engines`. Owner: engines agent. Paths: `src/features/**`, `src/engines/**` except `src/engines/null.ts`.

- [ ] 1. Feature library (`src/features/*.ts`): sma, ema, stdev, ATR 14, Bollinger 20/2 %B, RSI 14 (Wilder), EMA 9/21 spread and slope / ATR, wick-to-body ratios, Kaufman efficiency ratio, streak length and colour, 1m -> 5m/15m aggregation; unit-tested against hand-computed values
- [ ] 2. Feed-structure engine (`src/engines/feed-structure.ts`): autocorr lags 1..5, variance ratio, runs-test z, streak reversal rate, label + significance-based strength; label-rate test over many windows (random walk, k = 0.08, k = 0.2, trending)
- [ ] 3. Price action engine (`src/engines/price-action.ts`) + stats tracker (`src/engines/stats-tracker.ts`): hand-coded TUNABLE rules gated by feed label, reasons name the rule, per-asset stats, serialize/restore
- [ ] 4. Evidence on fixture generator: random walk ~50% within 99% CI and mostly abstains; bounded k = 0.08 and k = 0.2 vote rate and accuracy with n and Wilson 95% CI; tuned on one seed, reported on others
