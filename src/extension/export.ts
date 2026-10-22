// Export page (extension origin, so it opens the same IndexedDB as the service worker).
// Builds the file from many Blob parts and yields to the event loop between chunks, so large
// exports neither freeze the tab nor need one giant string.

import { openIndexedDbLedger } from '../ledger/indexeddb';
import { datasetChunks, rawFrameChunks, type Progress } from './exporter';

const BLOB_PART_CHARS = 8 * 1024 * 1024; // TUNABLE: fold strings into a Blob every ~8 MB so Chrome can page them out

type Kind = 'raw' | 'dataset';

function stamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

function card(kind: Kind) {
  const root = document.getElementById(kind)!;
  return {
    button: root.querySelector('button')!,
    bar: root.querySelector('progress')!,
    status: root.querySelector('.status')!,
  };
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

async function run(kind: Kind): Promise<void> {
  const ui = card(kind);
  ui.button.disabled = true;
  ui.status.classList.remove('error');
  ui.status.textContent = 'Opening the database…';
  ui.bar.hidden = false;
  ui.bar.removeAttribute('value');
  const started = Date.now();
  try {
    const ledger = await openIndexedDbLedger();
    const onProgress = (p: Progress) => {
      if (p.total) ui.bar.value = Math.min(1, p.done / p.total);
      ui.status.textContent = `${p.done.toLocaleString('en-US')}${p.total !== null ? ` / ${p.total.toLocaleString('en-US')}` : ''} ${kind === 'raw' ? 'frames' : 'ticks'}…`;
    };
    const chunks = kind === 'raw' ? rawFrameChunks(ledger, onProgress) : datasetChunks(ledger, Date.now(), onProgress);
    const parts: Blob[] = [];
    let pending: string[] = [];
    let pendingChars = 0;
    let totalChars = 0;
    let lines = 0;
    for await (const chunk of chunks) {
      pending.push(chunk);
      pendingChars += chunk.length;
      totalChars += chunk.length;
      for (let i = chunk.indexOf('\n'); i >= 0; i = chunk.indexOf('\n', i + 1)) lines++;
      if (pendingChars >= BLOB_PART_CHARS) {
        parts.push(new Blob(pending));
        pending = [];
        pendingChars = 0;
      }
      await yieldToUi();
    }
    if (pending.length) parts.push(new Blob(pending));
    ledger.close();
    if (lines === 0) {
      ui.status.textContent = 'Nothing to export yet: no raw frames are stored.';
      return;
    }
    const blob = new Blob(parts, { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quorum-${kind === 'raw' ? 'raw-frames' : 'dataset'}-${stamp()}.ndjson`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    ui.bar.value = 1;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    ui.status.textContent = `Done: ${lines.toLocaleString('en-US')} lines, ~${(totalChars / 1_048_576).toFixed(1)} MB in ${secs}s. Saved as ${a.download}.`;
  } catch (err) {
    ui.status.classList.add('error');
    ui.status.textContent = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    ui.button.disabled = false;
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-export]')) {
  b.addEventListener('click', () => void run(b.dataset.export as Kind));
}

// The panel opens export.html#raw or #dataset; start that export right away.
const wanted = location.hash.slice(1);
if (wanted === 'raw' || wanted === 'dataset') void run(wanted);
