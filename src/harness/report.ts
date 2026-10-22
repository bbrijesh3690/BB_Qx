// Scoreboard summary of a harness run: per engine x asset class, every percentage with its n.

import type { Ledger } from '../core/contracts';
import { binomialTestGreater, summarizeVotes, type VoteSummary } from '../core/stats';

/** BB_Qx.md: no edge claim below n = 600 scored votes per engine per asset class. */
export const MIN_EVIDENCE_N = 600;

export type AssetClass = 'OTC' | 'live';

export interface ReportRow {
  engine: string;
  assetClass: AssetClass;
  summary: VoteSummary;
  /** One-sided exact binomial p-value of accuracy > 50%, or null with no scored votes. */
  pValue: number | null;
}

/** Rows grouped by class (OTC first); within a class the null engine comes first. */
export async function scoreboard(ledger: Ledger, engines: readonly string[]): Promise<ReportRow[]> {
  const order = [...engines].sort((a, b) => (a === 'null' ? -1 : b === 'null' ? 1 : engines.indexOf(a) - engines.indexOf(b)));
  const rows: ReportRow[] = [];
  for (const assetClass of ['OTC', 'live'] as const) {
    for (const engine of order) {
      const votes = await ledger.queryVotes({ engine, isOTC: assetClass === 'OTC' });
      if (!votes.length) continue;
      const summary = summarizeVotes(votes);
      rows.push({ engine, assetClass, summary, pValue: summary.n ? binomialTestGreater(summary.hits, summary.n) : null });
    }
  }
  return rows;
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

export function formatScoreboard(rows: readonly ReportRow[]): string {
  const header = ['engine', 'class', 'votes', 'abstains', 'scored', 'ties', 'n', 'hits', 'accuracy', '95% CI', 'p(>50%)', 'note'];
  const body = rows.map(({ engine, assetClass, summary: s, pValue }) => [
    engine, assetClass, String(s.votes), String(s.abstains), String(s.scored), String(s.ties), String(s.n), String(s.hits),
    s.accuracy === null ? '-' : pct(s.accuracy),
    s.n ? `${pct(s.ci95.lo)}-${pct(s.ci95.hi)}` : '-',
    pValue === null ? '-' : pValue < 0.0001 ? '<0.0001' : pValue.toFixed(4),
    s.n < MIN_EVIDENCE_N ? 'building sample' : '',
  ]);
  const table = [header, ...body];
  const widths = header.map((_, c) => Math.max(...table.map((r) => r[c]!.length)));
  return table.map((r) => r.map((cell, c) => (c < 2 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join('  ').trimEnd()).join('\n');
}
