// Generates scripts/fixtures/raw-frames.sample.ndjson: hand-made frames shaped like the decoder's
// HYPOTHESES (not real Quotex traffic). Run: npx tsx scripts/fixtures/make-raw-frames-sample.ts <out>
import { writeFileSync } from 'node:fs';
import { bytesToBase64, utf8Encode } from '../../src/extension/quotex/bytes';

const out = process.argv[2]!;
const URL = 'wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket';
const T = 1792670400; // 2026-10-22T12:00:00Z, server seconds
const L = T * 1000 - 1500; // local clock 1.5 s behind
let seq = 0;
const lines: string[] = [];
const rec = (dir: 'in' | 'out', encoding: 'text' | 'base64', data: string, dt: number, tabId = 11) =>
  lines.push(JSON.stringify({ seq: ++seq, receivedAt: L + dt, tabId, socketUrl: URL, dir, encoding, data }));
const bin = (json: string) => bytesToBase64(new Uint8Array([4, ...utf8Encode(json)]));
const pair = (name: string, json: string, dt: number, tabId = 11) => {
  rec('in', 'text', `451-["${name}",{"_placeholder":true,"num":0}]`, dt, tabId);
  rec('in', 'base64', bin(json), dt, tabId);
};

rec('in', 'text', '0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":5000}', 0);
rec('in', 'text', '40', 1);
rec('out', 'text', '42["authorization","[redacted]"]', 2);
rec('in', 'text', '42["s_authorization"]', 50);
rec('out', 'text', '42["instruments/update",{"asset":"EURUSD_otc","period":60}]', 60);
rec('out', 'text', '42["depth/follow","EURUSD_otc"]', 61);
pair('instruments/list', JSON.stringify([
  [1, 'EURUSD_otc', 'EUR/USD (OTC)', 'currency', 2, 92, 60, 30, 3, 1, 170, 0, [], 0, true],
  [2, 'GBPUSD', 'GBP/USD', 'currency', 2, 85, 60, 30, 3, 1, 170, 0, [], 0, false],
]), 100);
const base = T - (T % 60) - 180;
pair('history/list/v2', JSON.stringify({
  asset: 'EURUSD_otc', period: 60, history: [[T - 5, 1.0712, 0]],
  candles: [[base, 1.07, 1.0712, 1.0715, 1.0698, 31], [base + 60, 1.0712, 1.0705, 1.0716, 1.0701, 28], [base + 120, 1.0705, 1.0705, 1.071, 1.07, 30], [base + 180, 1.0705, 1.0711, 1.0712, 1.0703, 12]],
}), 120);
for (let i = 0; i < 20; i++) {
  pair('quotes/stream', JSON.stringify([['EURUSD_otc', T + i * 0.5 + 0.125, 1.0705 + i * 1e-5, i % 2]]), 200 + i * 500);
  if (i % 2 === 0) pair('quotes/stream', JSON.stringify([['GBPUSD', T + i * 0.5, 1.27 + i * 1e-5, 0]]), 210 + i * 500);
}
// The same EURUSD_otc ticks seen from a second tab.
for (let i = 0; i < 4; i++) pair('quotes/stream', JSON.stringify([['EURUSD_otc', T + i * 0.5 + 0.125, 1.0705 + i * 1e-5, i % 2]]), 230 + i * 500, 22);
rec('in', 'text', '42["s_balance",{"liveBalance":0,"demoBalance":10000}]', 5000);
rec('out', 'text', '42["tick"]', 6000);
rec('in', 'text', '2', 25000);
rec('out', 'text', '3', 25001);
lines.push('this line is not JSON');
writeFileSync(out, lines.join('\n') + '\n');
console.log(`${lines.length} lines -> ${out}`);
