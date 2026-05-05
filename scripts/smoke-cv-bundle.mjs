#!/usr/bin/env node
// Smoke for cvBundle.mjs — graceful behavior on missing/malformed FS state.
// Spawns a tmp working dir + symlinks data/career to it so loadCvBundle's
// path.resolve('data') anchor resolves into the fixture rather than the
// real repo. Restored at the end.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { existsSync } from 'node:fs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed++;
  } catch (e) {
    console.error('FAIL:', name);
    console.error(e);
    process.exit(1);
  }
}

// Each test runs with cwd = a fresh tmp dir. loadCvBundle uses
// `path.resolve('data')` which respects process.cwd(), so chdir is enough.
const ORIG_CWD = process.cwd();

async function withTmp(setup, fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cv-bundle-smoke-'));
  process.chdir(tmp);
  // Build the data/career skeleton inside tmp.
  await fs.mkdir(path.join(tmp, 'data', 'career', 'qa-bank'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'data', 'career', 'resumes'), { recursive: true });
  try {
    await setup(tmp);
    // Force a fresh import each call so the module-level `path.resolve('data')`
    // anchors against the new cwd. Use a query-string cache buster.
    const mod = await import(
      `../src/career/evaluator/cvBundle.mjs?t=${Date.now()}_${Math.random()}`
    );
    await fn(mod, tmp);
  } finally {
    process.chdir(ORIG_CWD);
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ── Fully empty fixture ─────────────────────────────────────────────────
await test('empty fixture (no files at all) → all empty', async () => {
  await withTmp(
    async () => {},
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.equal(b.cv, '');
      assert.equal(b.narrative, '');
      assert.equal(b.proofPoints, '');
      assert.deepEqual(b.identity, {});
      assert.deepEqual(b.qaFewShot, []);
    }
  );
});

// ── Resume index with no default → cv stays empty ───────────────────────
await test('resumes:[] (matches real repo state) → cv=""', async () => {
  await withTmp(
    async (tmp) => {
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'resumes', 'index.yml'),
        'resumes: []\n'
      );
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.equal(b.cv, '');
    }
  );
});

await test('index has entries but none is_default → cv="" (no first-fallback)', async () => {
  await withTmp(
    async (tmp) => {
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'resumes', 'index.yml'),
        'resumes:\n  - id: backend\n    is_default: false\n  - id: applied-ai\n    is_default: false\n'
      );
      // Even though backend/base.md exists, no is_default → don't pick it.
      await fs.mkdir(path.join(tmp, 'data', 'career', 'resumes', 'backend'));
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'resumes', 'backend', 'base.md'),
        '# Should NOT be picked'
      );
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.equal(b.cv, '');
    }
  );
});

await test('default resume present → cv loaded from base.md', async () => {
  await withTmp(
    async (tmp) => {
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'resumes', 'index.yml'),
        'resumes:\n  - id: default\n    is_default: true\n'
      );
      await fs.mkdir(path.join(tmp, 'data', 'career', 'resumes', 'default'));
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'resumes', 'default', 'base.md'),
        '# My Resume\nSenior Software Engineer with 8 years experience.'
      );
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.match(b.cv, /Senior Software Engineer/);
    }
  );
});

await test('default entry exists but base.md missing → cv=""', async () => {
  await withTmp(
    async (tmp) => {
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'resumes', 'index.yml'),
        'resumes:\n  - id: default\n    is_default: true\n'
      );
      // No directory or base.md.
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.equal(b.cv, '');
    }
  );
});

await test('malformed index.yml → cv="" (no throw)', async () => {
  await withTmp(
    async (tmp) => {
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'resumes', 'index.yml'),
        'resumes:\n  - id: [unbalanced'
      );
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.equal(b.cv, '');
    }
  );
});

// ── narrative/proof-points ──────────────────────────────────────────────
await test('narrative + proof-points loaded as-is when present', async () => {
  await withTmp(
    async (tmp) => {
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'narrative.md'),
        '## Career Narrative\nFocus on platform reliability.'
      );
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'proof-points.md'),
        '- Reduced latency 40% in payment service'
      );
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.match(b.narrative, /platform reliability/);
      assert.match(b.proofPoints, /Reduced latency 40%/);
    }
  );
});

// ── identity.yml ────────────────────────────────────────────────────────
await test('identity.yml parsed to object', async () => {
  await withTmp(
    async (tmp) => {
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'identity.yml'),
        'name: Test Candidate\nemail: t@example.com\n'
      );
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.equal(b.identity.name, 'Test Candidate');
      assert.equal(b.identity.email, 't@example.com');
    }
  );
});

await test('malformed identity.yml → identity={} (no throw)', async () => {
  await withTmp(
    async (tmp) => {
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'identity.yml'),
        'name: [unbalanced'
      );
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.deepEqual(b.identity, {});
    }
  );
});

await test('identity.yml is a non-object scalar → identity={}', async () => {
  await withTmp(
    async (tmp) => {
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'identity.yml'),
        'just-a-string'
      );
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.deepEqual(b.identity, {});
    }
  );
});

// ── qa-bank/history.jsonl ───────────────────────────────────────────────
await test('empty history.jsonl → qaFewShot=[]', async () => {
  await withTmp(
    async (tmp) => {
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'qa-bank', 'history.jsonl'),
        ''
      );
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.deepEqual(b.qaFewShot, []);
    }
  );
});

await test('history.jsonl with malformed line → skip line, others kept', async () => {
  await withTmp(
    async (tmp) => {
      const lines = [
        JSON.stringify({ question: 'Q1', answer: 'A1' }),
        '{invalid json',
        JSON.stringify({ question: 'Q2', answer: 'A2' }),
      ].join('\n');
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'qa-bank', 'history.jsonl'),
        lines
      );
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.equal(b.qaFewShot.length, 2);
      assert.equal(b.qaFewShot[0].question, 'Q1');
      assert.equal(b.qaFewShot[1].question, 'Q2');
    }
  );
});

await test('history.jsonl with >5 entries → keep last 5', async () => {
  await withTmp(
    async (tmp) => {
      const lines = Array.from({ length: 8 }, (_, i) =>
        JSON.stringify({ question: `Q${i + 1}`, answer: `A${i + 1}` })
      ).join('\n');
      await fs.writeFile(
        path.join(tmp, 'data', 'career', 'qa-bank', 'history.jsonl'),
        lines
      );
    },
    async ({ loadCvBundle }) => {
      const b = await loadCvBundle();
      assert.equal(b.qaFewShot.length, 5);
      assert.equal(b.qaFewShot[0].question, 'Q4');
      assert.equal(b.qaFewShot[4].question, 'Q8');
    }
  );
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
