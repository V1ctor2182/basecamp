#!/usr/bin/env node
// Smoke for github-md adapter (SimplifyJobs-style HTML <table> parser).
// --live → also fetch real SimplifyJobs/New-Grad-Positions and assert ≥ 50 rows.

import assert from 'node:assert/strict';
import {
  githubMdAdapter,
  parseGithubMdTable,
} from '../src/career/finder/adapters/githubMd.mjs';
import { JobSchema } from '../src/career/lib/jobSchema.mjs';
import { resetRobotsCache } from '../src/career/finder/httpFetch.mjs';

const LIVE = process.argv.includes('--live');

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

const SOURCE = {
  type: 'github-md',
  name: 'SimplifyJobs New Grad',
  config: { owner: 'SimplifyJobs', repo: 'New-Grad-Positions', path: 'README.md', branch: 'dev' },
};

// Fixture mirroring real SimplifyJobs row HTML (3 standard + 1 ↳ continuation
// + 1 🔒 closed + 1 missing apply link).
const FIXTURE_MD = `# Header

<table>
<thead>
<tr>
<th>Company</th><th>Role</th><th>Location</th><th>Application</th><th>Age</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong><a href="https://simplify.jobs/c/Acme">🔥 Acme Corp</a></strong></td>
<td>Software Engineer 🇺🇸</td>
<td>San Francisco, CA</td>
<td><div align="center"><a href="https://acme.com/jobs/123"><img src="apply.png"></a> <a href="https://simplify.jobs/p/abc123">simplify</a></div></td>
<td>0d</td>
</tr>
<tr>
<td>↳</td>
<td>Backend Engineer</td>
<td>New York, NY</td>
<td><a href="https://simplify.jobs/p/xyz789">s</a> <a href="https://acme.com/jobs/456">apply</a></td>
<td>1d</td>
</tr>
<tr>
<td><strong><a href="https://simplify.jobs/c/Beta">Beta Co</a></strong></td>
<td>Closed Role 🔒</td>
<td>Remote</td>
<td><a href="https://beta.com/jobs/1">apply</a></td>
<td>5d</td>
</tr>
<tr>
<td><strong><a href="https://simplify.jobs/c/Gamma">Gamma</a></strong></td>
<td>SRE 🎓</td>
<td>Seattle, WA</td>
<td><div></div></td>
<td>2h</td>
</tr>
<tr>
<td><strong><a href="https://simplify.jobs/c/Delta">Delta</a></strong></td>
<td>ML Engineer</td>
<td>Boston, MA</td>
<td><a href="https://delta.com/careers/m1">apply</a></td>
<td>3w</td>
</tr>
</tbody>
</table>
`;

await test('1. parseGithubMdTable extracts all data rows (skips header)', () => {
  const rows = parseGithubMdTable(FIXTURE_MD);
  assert.equal(rows.length, 5);
});

await test('2. row 1 normal: company / role / link extracted, emoji stripped', () => {
  const rows = parseGithubMdTable(FIXTURE_MD);
  const r0 = rows[0];
  assert.equal(r0.companyRaw, 'Acme Corp');     // 🔥 stripped
  assert.equal(r0.role, 'Software Engineer');    // 🇺🇸 stripped
  assert.equal(r0.location, 'San Francisco, CA');
  assert.equal(r0.applyUrl, 'https://acme.com/jobs/123');  // non-simplify preferred
  assert.equal(r0.age, '0d');
});

await test('3. ↳ continuation marked (not yet resolved at parse stage)', () => {
  const rows = parseGithubMdTable(FIXTURE_MD);
  assert.equal(rows[1].companyRaw, '↳');
});

await test('4. 🔒 lock flagged via _roleHasLock', () => {
  const rows = parseGithubMdTable(FIXTURE_MD);
  assert.equal(rows[2]._roleHasLock, true);
});

await test('5. missing applyUrl row → applyUrl null/undefined', () => {
  const rows = parseGithubMdTable(FIXTURE_MD);
  assert.ok(!rows[3].applyUrl, 'expected no apply url');
});

await test('6. apply-link picker: prefers non-simplify even if simplify is first', () => {
  const rows = parseGithubMdTable(FIXTURE_MD);
  // Row 2: <a simplify> first then <a acme>; should pick acme.
  assert.equal(rows[1].applyUrl, 'https://acme.com/jobs/456');
});

await test('7. fetch wrapper: continuation resolved, closed/empty dropped', async () => {
  // Stub: simulate fetch by directly testing the wrapped behavior. We can't
  // hit the network here, so we test the logic by replicating the wrap step:
  const rows = parseGithubMdTable(FIXTURE_MD);
  // Apply same wrapping logic as in the adapter:
  let prev = null;
  const out = [];
  for (const r of rows) {
    let company = r.companyRaw;
    if (company === '↳') company = prev;
    else prev = company;
    if (r._roleHasLock) continue;
    if (!company) continue;
    if (!r.applyUrl) continue;
    out.push({ ...r, company });
  }
  // Expected: row 0 (Acme), row 1 (↳ → Acme), row 4 (Delta). Skip 2 (closed), 3 (no url).
  assert.equal(out.length, 3);
  assert.equal(out[0].company, 'Acme Corp');
  assert.equal(out[1].company, 'Acme Corp');
  assert.equal(out[2].company, 'Delta');
});

await test('8. normalize → JobSchema OK, posted_at within reasonable range', () => {
  const job = githubMdAdapter.normalize(
    {
      companyRaw: 'Acme Corp',
      company: 'Acme Corp',
      role: 'Software Engineer',
      location: 'San Francisco, CA',
      applyUrl: 'https://acme.com/jobs/123',
      age: '5d',
    },
    SOURCE
  );
  JobSchema.parse(job);
  assert.equal(job.source.type, 'github-md');
  assert.equal(job.company, 'Acme Corp');
  assert.equal(job.description, null); // deferred to enrich
  assert.match(job.posted_at, /Z$/);
  // 5 days ago: ~5 days from now.
  const ageMs = Date.now() - new Date(job.posted_at).getTime();
  assert.ok(ageMs > 4 * 86400000 && ageMs < 6 * 86400000, `age ms = ${ageMs}`);
});

await test('9. age "2h" → posted_at within last 3 hours', () => {
  const job = githubMdAdapter.normalize(
    { company: 'X', role: 'r', location: '', applyUrl: 'https://x.com/a', age: '2h' },
    SOURCE
  );
  const ageMs = Date.now() - new Date(job.posted_at).getTime();
  assert.ok(ageMs >= 2 * 3600000 - 60000 && ageMs <= 3 * 3600000, `age ms = ${ageMs}`);
});

await test('10. id stable across calls', () => {
  const r = { company: 'Acme', role: 'SDE', location: 'NYC', applyUrl: 'https://a.com/1', age: '0d' };
  const a = githubMdAdapter.normalize(r, SOURCE).id;
  const b = githubMdAdapter.normalize(r, SOURCE).id;
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{12}$/);
});

await test('11. fetch missing config rejects', async () => {
  await assert.rejects(githubMdAdapter.fetch({ repo: 'foo' }), /missing config/);
  await assert.rejects(githubMdAdapter.fetch({ owner: 'bar' }), /missing config/);
});

if (LIVE) {
  await test('LIVE-12. SimplifyJobs/New-Grad-Positions ≥ 50 rows + Zod', async () => {
    resetRobotsCache();
    const raws = await githubMdAdapter.fetch(SOURCE.config);
    assert.ok(raws.length >= 50, `got ${raws.length}`);
    // Sample 5 → JobSchema parse all
    for (const raw of raws.slice(0, 5)) {
      const job = githubMdAdapter.normalize(raw, SOURCE);
      JobSchema.parse(job);
    }
  });
}

console.log(`\n✅ All ${passed} smoke tests passed${LIVE ? ' (incl. live)' : ''}.`);
