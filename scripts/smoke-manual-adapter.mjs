#!/usr/bin/env node
// Smoke for manual paste adapter.
// Note: title-extraction live test would hit a third party URL. We test the
// pure logic here; the full POST endpoint is exercised separately via curl.

import assert from 'node:assert/strict';
import { manualPaste } from '../src/career/finder/adapters/manual.mjs';
import { JobSchema } from '../src/career/lib/jobSchema.mjs';

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

await test('1. with explicit title → uses it, JobSchema OK', async () => {
  const job = await manualPaste({
    url: 'https://example.com/careers/eng-123',
    title: 'Software Engineer',
    note: 'referred by friend',
  });
  JobSchema.parse(job);
  assert.equal(job.role, 'Software Engineer');
  assert.equal(job.company, 'example.com');
  assert.equal(job.source.type, 'manual');
  assert.deepEqual(job.location, []);
  assert.equal(job.description, null);
  assert.deepEqual(job.tags, ['enriched_via:manual_pending']);
  assert.equal(job.raw.note, 'referred by friend');
});

await test('2. invalid url throws', async () => {
  await assert.rejects(manualPaste({ url: 'not-a-url' }), /invalid url/);
});

await test('3. missing url throws', async () => {
  await assert.rejects(manualPaste({}), /url required/);
});

await test('4. www. prefix stripped from hostname → company', async () => {
  const job = await manualPaste({
    url: 'https://www.acme-corp.com/job/42',
    title: 'PM',
  });
  assert.equal(job.company, 'acme-corp.com');
});

await test('5. empty title string → falls through to extraction (returns "(untitled — manual paste)" in pure path)', async () => {
  // Pass empty title; title fetch will fail for non-existent host, role
  // should fall back to placeholder.
  const job = await manualPaste({
    url: 'https://this-host-does-not-exist-12345.example/job',
    title: '',
  });
  assert.equal(job.role, '(untitled — manual paste)');
});

await test('6. id stable for same url + title', async () => {
  const a = await manualPaste({ url: 'https://x.com/j/1', title: 'SDE' });
  const b = await manualPaste({ url: 'https://x.com/j/1', title: 'SDE' });
  assert.equal(a.id, b.id);
});

await test('7. URL is normalized (toString)', async () => {
  const job = await manualPaste({
    url: 'HTTPS://Example.COM:443/job?utm=x',
    title: 'X',
  });
  // URL.toString lowercases host, drops default port.
  assert.ok(job.url.startsWith('https://example.com/'));
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
