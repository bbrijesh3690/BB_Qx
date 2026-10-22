// Builds the unpacked extension into dist/extension (npm run build:ext).
// Load it via chrome://extensions -> Developer mode -> Load unpacked -> dist/extension.
//
// inject.js   MAIN-world page tap (IIFE, document_start)
// content.js  ISOLATED-world bridge + panel (IIFE, document_start)
// background.js  service worker (ESM)
// export.html + export.js  export page (ESM)
// manifest.json  from src/extension/manifest.json, with content-script matches from src/extension/hosts.json

import { execSync } from 'node:child_process';
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const src = path.join(root, 'src', 'extension');
const out = path.join(root, 'dist', 'extension');

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// A stamp that tells builds apart: chrome://extensions shows version_name, the panel shows the stamp.
const git = (args) => {
  try { return execSync(`git ${args}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};
const commit = git('rev-parse --short HEAD') || 'nogit';
const dirty = git('status --porcelain --untracked-files=no') ? '-dirty' : '';
const builtAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
const buildStamp = `v${pkg.version} · ${commit}${dirty} · built ${builtAt} UTC`;

const common = {
  bundle: true, target: 'chrome111', sourcemap: true, legalComments: 'none', logLevel: 'warning', charset: 'utf8',
  define: { __QUORUM_BUILD__: JSON.stringify(buildStamp) },
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await Promise.all([
  build({ ...common, entryPoints: [path.join(src, 'inject.ts')], outfile: path.join(out, 'inject.js'), format: 'iife' }),
  build({ ...common, entryPoints: [path.join(src, 'content.ts')], outfile: path.join(out, 'content.js'), format: 'iife' }),
  build({ ...common, entryPoints: [path.join(src, 'background', 'index.ts')], outfile: path.join(out, 'background.js'), format: 'esm' }),
  build({ ...common, entryPoints: [path.join(src, 'export.ts')], outfile: path.join(out, 'export.js'), format: 'esm' }),
]);

const hosts = JSON.parse(await readFile(path.join(src, 'hosts.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
manifest.version_name = `${pkg.version} (${commit}${dirty})`;
for (const cs of manifest.content_scripts) cs.matches = hosts;
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await copyFile(path.join(src, 'export.html'), path.join(out, 'export.html'));

// Every file the manifest and the export page reference must exist.
const exportHtml = await readFile(path.join(out, 'export.html'), 'utf8');
const referenced = [
  'manifest.json',
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((cs) => cs.js),
  'export.html',
  ...[...exportHtml.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]),
];
let missing = 0;
for (const f of [...new Set(referenced)]) {
  try {
    const s = await stat(path.join(out, f));
    console.log(`${f.padEnd(16)} ${(s.size / 1024).toFixed(1).padStart(8)} KB`);
  } catch {
    console.error(`MISSING ${f}`);
    missing++;
  }
}
if (missing) {
  console.error(`build incomplete: ${missing} referenced file(s) missing`);
  process.exit(1);
}
console.log(`built ${path.relative(root, out).replace(/\\/g, '/')} (matches: ${hosts.join(', ')})`);
