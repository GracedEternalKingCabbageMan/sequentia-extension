import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every module the extension loads must at least parse as an ES module. A
// duplicate top-level declaration is a SyntaxError that Chrome reports only in
// the service worker's console, which nothing else here exercises: the unit
// tests import the pure modules, never the engine. `node --check` parses a file
// without running it, but only treats it as ESM under an .mjs name, hence the
// temporary copies.
const root = new URL('..', import.meta.url).pathname;
const modules = [
  'background.js', 'offscreen.js', 'offscreen-boot.js',
  ...readdirSync(join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => 'src/' + f),
];

test('every extension module parses as an ES module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seqext-parse-'));
  for (const m of modules) {
    const copy = join(dir, m.replace(/\//g, '__') + '.mjs');
    writeFileSync(copy, readFileSync(join(root, m)));
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' }),
      m + ' does not parse',
    );
  }
});
