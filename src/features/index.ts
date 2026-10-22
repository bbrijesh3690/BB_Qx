// Feature library: one feature per indicator family (BB_Qx.md, Evidence). Features feed engines;
// they never vote. Deliberately absent: Stochastic, Williams %R, CCI (same as RSI) and MACD (same as the EMA spread).

export { closes, sma, ema, emaSeries, stdev } from './series';
export { atr, trueRange } from './atr';
export { bollinger, type Bollinger } from './bollinger';
export { rsi } from './rsi';
export { emaTrend, DEFAULT_EMA_TREND, type EmaTrend, type EmaTrendOptions } from './ema-trend';
export { candleShape, colourOf, WICK_RATIO_CAP, type CandleShape, type Colour } from './candle-shape';
export { efficiencyRatio, type Efficiency } from './regime';
export { streak, type Streak } from './streak';
export { aggregate, MINUTE_MS } from './aggregate';
