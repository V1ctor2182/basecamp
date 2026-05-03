#!/usr/bin/env node
// Smoke for atsByUrl + needs_manual_enrich Job schema field.
// Tests detectAtsType / refetchAtsContent / shouldEnrich. Mocks globalThis.fetch
// so per-ATS fetchers run end-to-end through httpFetch (robots check + body cap)
// without hitting the real network.

import assert from 'node:assert/strict';
import {
  detectAtsType,
  refetchAtsContent,
  shouldEnrich,
} from '../src/career/finder/atsByUrl.mjs';
import { resetRobotsCache } from '../src/career/finder/httpFetch.mjs';
import { JobSchema, normalizeJob } from '../src/career/lib/jobSchema.mjs';

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

// Build a stub Response (the parts httpFetch actually uses).
function stubResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const buf = Buffer.from(text, 'utf-8');
  let consumed = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => text,
    body: {
      getReader: () => ({
        read: async () => {
          if (consumed) return { done: true, value: undefined };
          consumed = true;
          return { done: false, value: buf };
        },
        cancel: async () => {},
      }),
    },
  };
}

// Install a fetch mock for a single test, then restore.
async function withMockedFetch(handler, fn) {
  const orig = globalThis.fetch;
  resetRobotsCache(); // robots cache is per-process; reset between tests
  globalThis.fetch = async (url, init) => {
    if (typeof url !== 'string') url = String(url);
    // Default: any robots.txt → 404 (allow-all)
    if (url.endsWith('/robots.txt')) return stubResponse(404, '');
    return handler(url, init);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
    resetRobotsCache();
  }
}

// ── Schema field ────────────────────────────────────────────────────────
await test('schema-1. Existing job without needs_manual_enrich → defaults to false', () => {
  const j = normalizeJob({
    id: '0123456789ab',
    source: { type: 'greenhouse', name: 'X', url: null },
    company: 'Anthropic',
    role: 'SWE',
    location: ['SF'],
    url: 'https://x.example/job',
    description: null,
    posted_at: null,
    comp_hint: null,
  });
  assert.equal(j.needs_manual_enrich, false);
});

await test('schema-2. Job with needs_manual_enrich=true round-trips through Zod', () => {
  const j = normalizeJob({
    id: '0123456789ab',
    source: { type: 'greenhouse', name: 'X', url: null },
    company: 'Anthropic',
    role: 'SWE',
    location: ['SF'],
    url: 'https://x.example/job',
    description: null,
    posted_at: null,
    comp_hint: null,
    needs_manual_enrich: true,
  });
  assert.equal(j.needs_manual_enrich, true);
});

await test('schema-3. JobSchema rejects non-boolean needs_manual_enrich', () => {
  const bad = {
    id: '0123456789ab',
    source: { type: 'greenhouse', name: 'X', url: null },
    company: 'Anthropic',
    role: 'SWE',
    location: ['SF'],
    url: 'https://x.example/job',
    description: null,
    posted_at: null,
    scraped_at: new Date().toISOString(),
    comp_hint: null,
    tags: [],
    raw: null,
    schema_version: 1,
    needs_manual_enrich: 'maybe',
  };
  assert.throws(() => JobSchema.parse(bad));
});

// ── detectAtsType — URL detection (12 cases) ─────────────────────────────
await test('detect-1. greenhouse boards.greenhouse.io path form', () => {
  const r = detectAtsType('https://boards.greenhouse.io/anthropic/jobs/4012345');
  assert.deepEqual(r, { type: 'greenhouse', slug: 'anthropic', id: '4012345' });
});

await test('detect-2. greenhouse subdomain form', () => {
  const r = detectAtsType('https://anthropic.boards.greenhouse.io/jobs/4012345');
  assert.deepEqual(r, { type: 'greenhouse', slug: 'anthropic', id: '4012345' });
});

await test('detect-3. greenhouse newer job-boards subdomain', () => {
  const r = detectAtsType('https://job-boards.greenhouse.io/stripe/jobs/9999');
  assert.deepEqual(r, { type: 'greenhouse', slug: 'stripe', id: '9999' });
});

await test('detect-4. ashby uuid path', () => {
  const r = detectAtsType('https://jobs.ashbyhq.com/openai/aabbccdd-1111-2222-3333-444455556666');
  assert.deepEqual(r, {
    type: 'ashby',
    slug: 'openai',
    id: 'aabbccdd-1111-2222-3333-444455556666',
  });
});

await test('detect-5. ashby with /application suffix', () => {
  const r = detectAtsType('https://jobs.ashbyhq.com/notion/aabbccdd-1111-2222-3333-444455556666/application');
  assert.equal(r?.type, 'ashby');
  assert.equal(r?.slug, 'notion');
});

await test('detect-6. lever uuid path', () => {
  const r = detectAtsType('https://jobs.lever.co/perplexity/aabbccdd-1111-2222-3333-444455556666');
  assert.deepEqual(r, {
    type: 'lever',
    slug: 'perplexity',
    id: 'aabbccdd-1111-2222-3333-444455556666',
  });
});

await test('detect-7. recruitee subdomain + offer slug', () => {
  const r = detectAtsType('https://acme.recruitee.com/o/senior-engineer-remote');
  assert.deepEqual(r, { type: 'recruitee', slug: 'acme', id: 'senior-engineer-remote' });
});

await test('detect-8. smartrecruiters with seo-slug suffix', () => {
  const r = detectAtsType('https://jobs.smartrecruiters.com/Bosch/743999123456789-software-engineer');
  assert.deepEqual(r, { type: 'smartrecruiters', slug: 'Bosch', id: '743999123456789' });
});

await test('detect-9. smartrecruiters posting id only', () => {
  const r = detectAtsType('https://jobs.smartrecruiters.com/Acme/743999');
  assert.deepEqual(r, { type: 'smartrecruiters', slug: 'Acme', id: '743999' });
});

await test('detect-10. workday detected (tenant captured) regardless of region subdomain', () => {
  const r = detectAtsType('https://acme.wd1.myworkdayjobs.com/External/job/Remote/SWE_R12345');
  assert.equal(r?.type, 'workday');
  assert.equal(r?.slug, 'acme');
});

await test('detect-11. URL with trailing slash + query string + fragment still matches', () => {
  const r = detectAtsType('https://boards.greenhouse.io/anthropic/jobs/4012345/?gh_src=foo#applicant');
  assert.deepEqual(r, { type: 'greenhouse', slug: 'anthropic', id: '4012345' });
});

await test('detect-12. random / malformed / non-ATS URL → null', () => {
  assert.equal(detectAtsType(''), null);
  assert.equal(detectAtsType('not a url'), null);
  assert.equal(detectAtsType('ftp://example.com/x'), null);
  assert.equal(detectAtsType('https://example.com/jobs/123'), null);
  assert.equal(detectAtsType('https://boards.greenhouse.io/'), null); // no slug/id
  assert.equal(detectAtsType(null), null);
  assert.equal(detectAtsType(undefined), null);
});

// ── refetchAtsContent — per-ATS response parsing (5 fetchers + workday) ──
await test('fetch-greenhouse. content field → stripped description', async () => {
  await withMockedFetch(
    async (url) => {
      assert.match(url, /boards-api\.greenhouse\.io\/v1\/boards\/anthropic\/jobs\/4012345/);
      return stubResponse(200, {
        content: '<p>Build <strong>safe AI</strong>. Join Anthropic.</p>',
      });
    },
    async () => {
      const r = await refetchAtsContent({ type: 'greenhouse', slug: 'anthropic', id: '4012345' });
      assert.equal(r.skip, undefined);
      assert.equal(r.description, 'Build safe AI . Join Anthropic.');
    }
  );
});

await test('fetch-ashby. board returns matching id → descriptionHtml stripped', async () => {
  await withMockedFetch(
    async (url) => {
      assert.match(url, /api\.ashbyhq\.com\/posting-api\/job-board\/openai/);
      return stubResponse(200, {
        jobs: [
          { id: 'other-uuid', descriptionHtml: '<p>WRONG</p>' },
          { id: 'aabbccdd-1111-2222-3333-444455556666', descriptionHtml: '<p>Right job desc.</p>' },
        ],
      });
    },
    async () => {
      const r = await refetchAtsContent({
        type: 'ashby',
        slug: 'openai',
        id: 'aabbccdd-1111-2222-3333-444455556666',
      });
      assert.equal(r.description, 'Right job desc.');
    }
  );
});

await test('fetch-ashby. id not in board → null + error', async () => {
  await withMockedFetch(
    async () => stubResponse(200, { jobs: [{ id: 'other', descriptionHtml: '<p>X</p>' }] }),
    async () => {
      const r = await refetchAtsContent({ type: 'ashby', slug: 'x', id: 'missing-uuid-1234' });
      assert.equal(r.description, null);
      assert.match(r.error, /not found/);
    }
  );
});

await test('fetch-lever. descriptionPlain preferred over description', async () => {
  await withMockedFetch(
    async (url) => {
      assert.match(url, /api\.lever\.co\/v0\/postings\/perplexity\/aabbccdd/);
      return stubResponse(200, {
        descriptionPlain: 'Plain text JD here.',
        description: '<p>HTML version</p>',
      });
    },
    async () => {
      const r = await refetchAtsContent({
        type: 'lever',
        slug: 'perplexity',
        id: 'aabbccdd-1111-2222-3333-444455556666',
      });
      assert.equal(r.description, 'Plain text JD here.');
    }
  );
});

await test('fetch-lever. fallback to stripped description when descriptionPlain missing', async () => {
  await withMockedFetch(
    async () =>
      stubResponse(200, {
        descriptionPlain: '',
        description: '<p>Only HTML</p>',
      }),
    async () => {
      const r = await refetchAtsContent({
        type: 'lever',
        slug: 'x',
        id: 'aabbccdd-1111-2222-3333-444455556666',
      });
      assert.equal(r.description, 'Only HTML');
    }
  );
});

await test('fetch-recruitee. offer.description stripped', async () => {
  await withMockedFetch(
    async (url) => {
      assert.match(url, /acme\.recruitee\.com\/api\/offers\/senior-eng/);
      return stubResponse(200, { offer: { description: '<p>Senior eng role.</p>' } });
    },
    async () => {
      const r = await refetchAtsContent({ type: 'recruitee', slug: 'acme', id: 'senior-eng' });
      assert.equal(r.description, 'Senior eng role.');
    }
  );
});

await test('fetch-smartrecruiters. concatenates 3 sections', async () => {
  await withMockedFetch(
    async (url) => {
      assert.match(url, /api\.smartrecruiters\.com\/v1\/companies\/Bosch\/postings\/743999/);
      return stubResponse(200, {
        jobAd: {
          sections: {
            jobDescription: { text: 'Description text.' },
            qualifications: { text: 'Quals text.' },
            additionalInformation: { text: 'Extra text.' },
          },
        },
      });
    },
    async () => {
      const r = await refetchAtsContent({ type: 'smartrecruiters', slug: 'Bosch', id: '743999' });
      assert.match(r.description, /Description text\..*Quals text\..*Extra text\./);
    }
  );
});

await test('fetch-error. HTTP 500 → null + error string', async () => {
  await withMockedFetch(
    async () => stubResponse(500, 'oops'),
    async () => {
      const r = await refetchAtsContent({ type: 'greenhouse', slug: 'x', id: '1' });
      assert.equal(r.description, null);
      assert.match(r.error, /HTTP 500/);
    }
  );
});

await test('fetch-workday. detect-only → { skip: true } without HTTP call', async () => {
  let calls = 0;
  await withMockedFetch(
    async () => {
      calls++;
      return stubResponse(200, {});
    },
    async () => {
      const r = await refetchAtsContent({
        type: 'workday',
        slug: 'acme',
        id: '/External/job/Remote/SWE_R12345',
      });
      assert.deepEqual(r, { skip: true });
      assert.equal(calls, 0); // no fetch attempted
    }
  );
});

await test('orchestrator. unknown type → error, no throw', async () => {
  const r = await refetchAtsContent({ type: 'unknown', slug: 'x', id: '1' });
  assert.equal(r.description, null);
  assert.match(r.error, /unsupported type/);
});

await test('orchestrator. null detection → error, no throw', async () => {
  const r = await refetchAtsContent(null);
  assert.equal(r.description, null);
  assert.match(r.error, /no detection/);
});

// ── shouldEnrich threshold ───────────────────────────────────────────────
await test('shouldEnrich-1. description.length > 500 → false (skip)', () => {
  assert.equal(shouldEnrich({ description: 'x'.repeat(501) }), false);
});
await test('shouldEnrich-2. description.length === 500 → true (enrich)', () => {
  assert.equal(shouldEnrich({ description: 'x'.repeat(500) }), true);
});
await test('shouldEnrich-3. description=null → true (needs enrich)', () => {
  assert.equal(shouldEnrich({ description: null }), true);
});
await test('shouldEnrich-4. malformed input → false (no-op)', () => {
  assert.equal(shouldEnrich(null), false);
  assert.equal(shouldEnrich(undefined), false);
});

console.log(`\n✅ All ${passed} smoke tests passed.`);
