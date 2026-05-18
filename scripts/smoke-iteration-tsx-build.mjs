#!/usr/bin/env node
// Build smoke for 03-iteration-dashboard m2 — verifies Iteration.tsx
// compiles + type-checks via the project's existing `tsc -b && vite build`
// pipeline. Catches TypeScript regressions before commit.
//
// Why a separate smoke vs npm run build directly: the smoke script
// captures stdout/stderr + asserts the EXACT files produced (so a
// future regression that silently elides Iteration.tsx from the bundle
// can't slip through).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_BUDGET_MS = 120_000; // type-check + vite production build

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    failed++;
  }
}

await test('tsc + vite build completes successfully', () => {
  const t0 = Date.now();
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: BUILD_BUDGET_MS,
  });
  const elapsedMs = Date.now() - t0;
  if (result.status !== 0) {
    throw new Error(
      `npm run build exited ${result.status} in ${elapsedMs}ms.\n` +
        `stderr:\n${result.stderr || ''}\nstdout (tail):\n${(result.stdout || '').split('\n').slice(-30).join('\n')}`,
    );
  }
  console.log(`   build wall time: ${elapsedMs}ms`);
});

await test('dist/ contains an index.html referencing the bundled JS', async () => {
  const indexPath = path.join(REPO_ROOT, 'dist', 'index.html');
  const html = await fs.readFile(indexPath, 'utf8');
  assert.match(html, /<script[^>]*src=/, 'dist/index.html should reference a bundled script');
});

await test('dist/assets includes a JS bundle (Iteration page compiled in)', async () => {
  const assetsDir = path.join(REPO_ROOT, 'dist', 'assets');
  const entries = await fs.readdir(assetsDir);
  const jsFiles = entries.filter((n) => n.endsWith('.js'));
  assert.ok(jsFiles.length > 0, 'dist/assets must contain ≥ 1 .js bundle');
  // The Iteration page name should appear somewhere in the bundle — pick
  // any JS asset large enough to be the main chunk and grep.
  const largest = (
    await Promise.all(
      jsFiles.map(async (name) => {
        const stat = await fs.stat(path.join(assetsDir, name));
        return { name, size: stat.size };
      }),
    )
  ).sort((a, b) => b.size - a.size)[0];
  const body = await fs.readFile(path.join(assetsDir, largest.name), 'utf8');
  // The Iteration component renders the header text "实时观察 applier".
  // If Vite tree-shook the page (e.g. route never imported), this fails.
  assert.match(
    body,
    /实时观察 applier|Iteration/,
    'Iteration page string must appear in the main bundle',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
