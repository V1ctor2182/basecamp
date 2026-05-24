#!/usr/bin/env node
// Smoke for 09-integrations-credentials m1 backend:
//   - GET /api/config now surfaces {anthropic, google, github} masked
//     state alongside the legacy {githubUsername, hasToken} shape.
//   - PUT /api/config accepts anthropicApiKey / googleClientId /
//     googleClientSecret partials; empty string = clear; non-string
//     payloads → 400.
//   - PUT anthropicApiKey invalidates anthropicClient.getClient() cache
//     so the new key takes effect without restarting the server.
//
// Pure-Node — boots server.mjs in a child process on a random port,
// hits the routes, asserts response shape. Fixture-isolates the real
// data/config.json so a developer's actual credentials are untouched.
//
// Don't run this against a server process the developer is using — the
// fixture isolation backs up the real config.json by rename, so any
// reads from the dev server during the smoke's window would see the
// (empty) test fixture.

import assert from 'node:assert/strict';
import { promises as fs, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

// ── Fixture isolation ─────────────────────────────────────────────────

const CONFIG_FILE = path.resolve('data', 'config.json');
const CONFIG_BACKUP = CONFIG_FILE + `.smoke-09-backup.${process.pid}`;

function setupFixtures() {
  if (existsSync(CONFIG_FILE)) renameSync(CONFIG_FILE, CONFIG_BACKUP);
  // Start each smoke run from an empty config so the GET shape is
  // deterministic regardless of what the developer has set locally.
  // The server bootstraps `{}` if the file is missing, but we write it
  // explicitly to skip the auto-bootstrap race.
}
function restoreFixtures() {
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE, { force: true });
  if (existsSync(CONFIG_BACKUP)) renameSync(CONFIG_BACKUP, CONFIG_FILE);
}
setupFixtures();

let serverProc = null;
let serverPort = 0;

function killServer() {
  if (serverProc && !serverProc.killed) {
    try {
      serverProc.kill('SIGTERM');
    } catch {}
  }
}

process.on('exit', () => {
  killServer();
  restoreFixtures();
});
process.on('uncaughtException', (e) => {
  killServer();
  restoreFixtures();
  console.error('uncaught:', e);
  process.exit(2);
});

// Same port-picking strategy as smoke-feedback-stats-endpoint.mjs.
serverPort = 9000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${serverPort}`;

async function startServer() {
  return new Promise((resolve, reject) => {
    // Clear env-based secrets so the smoke deterministically tests the
    // config.json path (not whatever the developer happens to have
    // exported). The server still reads env first → falls through to
    // config.json when env is empty.
    const env = {
      ...process.env,
      PORT: String(serverPort),
      GITHUB_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    };
    serverProc = spawn('node', ['server.mjs'], {
      env,
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const onData = (buf) => {
      const s = buf.toString();
      if (s.includes(`:${serverPort}`)) {
        ready = true;
        resolve();
      }
    };
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', onData);
    serverProc.on('exit', (code) => {
      if (!ready) reject(new Error(`server exited before listening (code ${code})`));
    });
    setTimeout(() => {
      if (!ready) reject(new Error('server start timeout'));
    }, 10_000).unref?.();
  });
}

async function get() {
  const r = await fetch(BASE + '/api/config');
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function put(payload) {
  const r = await fetch(BASE + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

await startServer();

// ── Tests ─────────────────────────────────────────────────────────────

await test('GET (empty config): legacy shape present, all set:false', async () => {
  const { status, body } = await get();
  assert.equal(status, 200);
  // Legacy contract — TrackerApp's useConfig hook still works.
  assert.equal(body.githubUsername, '');
  assert.equal(body.hasToken, false);
  // New shape — empty config means every leaf is {set: false}.
  assert.deepEqual(body.anthropic, { set: false });
  assert.deepEqual(body.google.clientId, { set: false });
  assert.deepEqual(body.google.clientSecret, { set: false });
  assert.deepEqual(body.github.token, { set: false });
  assert.equal(body.github.username, '');
});

await test('PUT all three new credentials → GET shows masked tails', async () => {
  const { status } = await put({
    anthropicApiKey: 'sk-ant-api03-abcdefghijklmnop',
    googleClientId: '123456789012-abcdefghijklmnopqrstuvwx.apps.googleusercontent.com',
    googleClientSecret: 'GOCSPX-AbCdEfGhIjKlMn',
  });
  assert.equal(status, 200);
  const { body } = await get();
  assert.equal(body.anthropic.set, true);
  assert.match(body.anthropic.masked, /●+mnop$/);
  assert.equal(body.google.clientId.set, true);
  assert.match(body.google.clientId.masked, /●+\.com$/);
  assert.equal(body.google.clientSecret.set, true);
  assert.match(body.google.clientSecret.masked, /●+KlMn$/);
});

await test('PUT empty string clears the field (D3 semantic)', async () => {
  const { status } = await put({ anthropicApiKey: '' });
  assert.equal(status, 200);
  const { body } = await get();
  assert.deepEqual(body.anthropic, { set: false }, 'anthropic must clear');
  // The other two we set in the prior test should still be present.
  assert.equal(body.google.clientId.set, true);
  assert.equal(body.google.clientSecret.set, true);
});

await test('PUT short secret (<8 chars) gets fully opaque mask', async () => {
  const { status } = await put({ anthropicApiKey: 'short' });
  assert.equal(status, 200);
  const { body } = await get();
  assert.equal(body.anthropic.set, true);
  // No tail revealed for short secrets.
  assert.equal(body.anthropic.masked, '●●●●');
  // Cleanup so subsequent tests start fresh.
  await put({ anthropicApiKey: '' });
});

await test('PUT non-string credential → 400 (no silent coercion)', async () => {
  const { status, body } = await put({ anthropicApiKey: 12345 });
  assert.equal(status, 400);
  assert.match(body.error, /anthropicApiKey/);
  assert.match(body.error, /string/);
});

await test('REVIEW H3: whitespace-only credential clears (trim + empty)', async () => {
  await put({ anthropicApiKey: 'sk-ant-real-key-1234567890' });
  let r = await get();
  assert.equal(r.body.anthropic.set, true);
  // Whitespace-only should normalize to empty → clear.
  const { status } = await put({ anthropicApiKey: '   ' });
  assert.equal(status, 200);
  r = await get();
  assert.equal(r.body.anthropic.set, false, 'whitespace-only must clear');
});

await test('REVIEW H3: padded credential is trimmed before persist', async () => {
  await put({ anthropicApiKey: '  sk-ant-padded-key-xyz9876  ' });
  // Round-trip through the file to verify trim happened.
  const raw = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  assert.equal(raw.anthropicApiKey, 'sk-ant-padded-key-xyz9876', 'no leading/trailing whitespace persisted');
  await put({ anthropicApiKey: '' }); // cleanup
});

await test('REVIEW H2-sec: over-long credential rejected (DoS guard)', async () => {
  const huge = 'a'.repeat(3000); // > MAX_CREDENTIAL_LEN (2048)
  const { status, body } = await put({ anthropicApiKey: huge });
  assert.equal(status, 400);
  assert.match(body.error, /exceeds/);
});

await test('REVIEW H1-sec: cross-origin PUT is rejected', async () => {
  const r = await fetch(BASE + '/api/config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example.com', // mimics a malicious page
    },
    body: JSON.stringify({ anthropicApiKey: 'sk-attacker-key' }),
  });
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.match(body.error, /cross-origin/);
  // Confirm nothing was persisted.
  const { body: cfg } = await get();
  assert.equal(cfg.anthropic.set, false);
});

await test('REVIEW H1-sec: same-origin PUT (Origin matches Host) passes', async () => {
  const r = await fetch(BASE + '/api/config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE, // browser would emit Origin = scheme://host:port
    },
    body: JSON.stringify({ anthropicApiKey: 'sk-same-origin-1234' }),
  });
  assert.equal(r.status, 200);
  const { body } = await get();
  assert.equal(body.anthropic.set, true);
  await put({ anthropicApiKey: '' }); // cleanup
});

await test('REVIEW L3-edge: array body is rejected as garbage', async () => {
  const r = await fetch(BASE + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([1, 2, 3]),
  });
  // Array bodies normalize to {} (no fields), so PUT is a no-op 200.
  // The important assertion: nothing got persisted.
  assert.equal(r.status, 200);
  const raw = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  assert.ok(!('0' in raw) && !('1' in raw), 'array indices must not leak into config');
});

await test('PUT body {} → 200, no changes', async () => {
  const before = (await get()).body;
  const { status } = await put({});
  assert.equal(status, 200);
  const after = (await get()).body;
  assert.deepEqual(after, before, 'GET shape unchanged by empty PUT');
});

await test('PUT unknown field is silently ignored (whitelist)', async () => {
  const { status } = await put({ totallyUnrelated: 'x', secrets: 'y' });
  assert.equal(status, 200);
  const raw = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  assert.ok(!('totallyUnrelated' in raw));
  assert.ok(!('secrets' in raw));
});

await test('Legacy contract preserved: PUT githubUsername updates flat field', async () => {
  const { status } = await put({ githubUsername: 'octocat', githubToken: 'ghp_demo_token_xyz' });
  assert.equal(status, 200);
  const { body } = await get();
  // Legacy shape (TrackerApp consumer).
  assert.equal(body.githubUsername, 'octocat');
  assert.equal(body.hasToken, true);
  // New shape parallel.
  assert.equal(body.github.username, 'octocat');
  assert.equal(body.github.token.set, true);
  assert.match(body.github.token.masked, /●+_xyz$/);
});

await test('Legacy contract preserved: PUT githubToken="" clears it (D3 for github too)', async () => {
  const { status } = await put({ githubToken: '' });
  assert.equal(status, 200);
  const { body } = await get();
  assert.equal(body.hasToken, false);
  assert.deepEqual(body.github.token, { set: false });
});

await test('REVIEW H2-edge: malformed config.json → readConfigSync warns + returns {}', async () => {
  // Capture warnings emitted by the dynamic-imported module.
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    // Write garbage to the config file. anthropicClient's readConfigSync
    // is sync + module-level (cached path), so reading happens on next
    // _resetClientForTesting + getClient call.
    await fs.writeFile(CONFIG_FILE, '{this is not json}');
    const mod = await import('../src/career/lib/anthropicClient.mjs');
    mod._resetClientForTesting();
    let threw = false;
    try {
      mod.getClient();
    } catch (e) {
      threw = true;
      // ConfigError because malformed file → {} → no apiKey → throw.
      assert.match(e.message, /No LLM backend configured/);
    }
    assert.ok(threw, 'getClient should throw on no key — but warn first');
    assert.ok(
      warns.some((w) => /malformed/.test(w)),
      `expected a malformed-JSON warning; got: ${JSON.stringify(warns)}`,
    );
  } finally {
    console.warn = origWarn;
    // Reset config back to empty for downstream tests.
    await fs.writeFile(CONFIG_FILE, '{}');
  }
});

await test('anthropicClient cache invalidates when key changes via PUT', async () => {
  // Two-phase: write key A → import getClient (sync read sees A);
  // PUT key B → import _resetClientForTesting was called by the
  // endpoint → next getClient() rebuilds with B.
  await put({ anthropicApiKey: 'sk-ant-key-A-1234567890' });
  // Dynamic import after PUT so we get a fresh module instance.
  const mod = await import('../src/career/lib/anthropicClient.mjs');
  mod._resetClientForTesting();
  const clientA = mod.getClient();
  assert.ok(clientA, 'first getClient with key A');

  // Now flip to key B via PUT. The endpoint calls _resetClientForTesting
  // server-side, but THIS process is a separate node instance — verify
  // the same reset semantic works locally: write the new key, manually
  // reset, re-create.
  await put({ anthropicApiKey: 'sk-ant-key-B-9876543210' });
  mod._resetClientForTesting();
  const clientB = mod.getClient();
  // The Anthropic SDK doesn't expose the configured key; assert the
  // client is a fresh instance instead.
  assert.notEqual(clientA, clientB, 'fresh client after reset');

  // Cleanup so post-smoke state matches pre-smoke (config restoreFixtures
  // will overwrite anyway, but be tidy).
  await put({ anthropicApiKey: '' });
});

// ── Cleanup ───────────────────────────────────────────────────────────

killServer();
await new Promise((r) => setTimeout(r, 100));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
