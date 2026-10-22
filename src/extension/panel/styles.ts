// Panel styles. The panel draws its own opaque background so it reads the same on dark and light
// pages; the shadow root keeps page CSS out and ours in.

export const PANEL_CSS = `
:host { all: initial; }
.panel {
  --bg: #0f172a; --bg2: #1e293b; --fg: #e2e8f0; --muted: #94a3b8; --line: #334155;
  --green: #22c55e; --red: #ef4444; --grey: #64748b; --doji: #cbd5e1; --accent: #38bdf8;
  width: 360px; max-width: calc(100vw - 16px);
  background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,.45);
  font: 12px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  overflow: hidden;
}
.head {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; background: var(--bg2); cursor: move; user-select: none;
}
.head b { font-weight: 600; letter-spacing: .02em; }
.head .sum { flex: 1; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; background: var(--grey); }
.dot.green { background: var(--green); } .dot.red { background: var(--red); } .dot.grey { background: var(--grey); }
button {
  font: inherit; color: var(--fg); background: #334155; border: 1px solid #475569;
  border-radius: 5px; padding: 3px 8px; cursor: pointer;
}
button:hover { background: #475569; }
button.icon { padding: 0 7px; line-height: 18px; }
.body { max-height: 70vh; overflow: auto; padding: 6px 8px 8px; }
.collapsed .body { display: none; }
section { margin: 0 0 8px; }
h3 { margin: 6px 0 3px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th { text-align: left; color: var(--muted); font-weight: 500; padding: 1px 3px; border-bottom: 1px solid var(--line); }
td { padding: 1px 3px; white-space: nowrap; }
td.num, th.num { text-align: right; }
tr.self td { color: var(--accent); }
.muted { color: var(--muted); }
.empty { color: var(--muted); padding: 6px 0; }
.banner { display: none; margin: 0 0 6px; padding: 5px 6px; border-radius: 5px; background: #7f1d1d; color: #fee2e2; }
.banner.show { display: block; }
.row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.chip { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; margin-right: 4px; }
.chip.green { background: var(--green); } .chip.red { background: var(--red); } .chip.doji { background: var(--doji); }
details summary { cursor: pointer; color: var(--muted); margin: 6px 0 3px; }
select { font: inherit; color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
.errs li { color: #fca5a5; }
ul { margin: 2px 0; padding-left: 16px; }
`;
