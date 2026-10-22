// Determinism guard: core, engines, features, harness and the in-memory ledger must not read a
// clock or an unseeded RNG. Comments are ignored (contracts.ts names the banned calls in one);
// string contents are kept, so the guard errs on the side of flagging.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SCANNED = ['src/core', 'src/engines', 'src/features', 'src/harness', 'src/ledger/memory.ts'];
const BANNED = [/\bDate\s*\.\s*now\s*\(/, /\bMath\s*\.\s*random\s*\(/, /\bperformance\s*\.\s*now\s*\(/];

/** Removes // and /* *\/ comments, leaving strings and template literals (including ${...} code) intact. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const braces: number[] = []; // brace depth at each open template ${ ... }
  let depth = 0;
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '`' || (c === '}' && braces.length && braces[braces.length - 1] === depth)) {
      if (c === '}') { braces.pop(); depth--; }
      let j = i + 1;
      while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1;
      if (src[j] === '$') { depth++; braces.push(depth); j += 2; out += src.slice(i, j); i = j; continue; }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      out += c;
      i++;
    }
  }
  return out;
}

function sourceFiles(path: string): string[] {
  const abs = resolve(ROOT, path);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs).flatMap((name) => {
    const p = join(abs, name);
    if (statSync(p).isDirectory()) return sourceFiles(relative(ROOT, p));
    return /\.(ts|mts|cts|js|mjs|cjs)$/.test(name) ? [p] : [];
  });
}

describe('determinism guard', () => {
  it('the comment stripper keeps code and strings and drops comments', () => {
    const src = [
      '// Date.now() in a line comment',
      '/* Math.random() in a block */ const a = 1;',
      "const s = 'not // a comment'; Date.now();",
      'const t = `x ${performance.now()} y`; // trailing',
      'const u = `${ {a: 1}.a } then`; Math.random();',
    ].join('\n');
    const hits = BANNED.filter((re) => re.test(stripComments(src))).length;
    expect(hits).toBe(3);
    expect(stripComments('// Date.now()\n/* Math.random() */')).not.toMatch(/now|random/);
  });

  it('finds no Date.now(), Math.random() or performance.now() in deterministic code', () => {
    const files = SCANNED.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      const lines = stripComments(readFileSync(f, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (BANNED.some((re) => re.test(line))) offenders.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
