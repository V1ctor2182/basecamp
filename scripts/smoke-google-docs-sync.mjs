#!/usr/bin/env node
// Smoke test for src/career/lib/googleDocs.mjs
// Run: node scripts/smoke-google-docs-sync.mjs

import assert from 'node:assert/strict';
import {
  buildGoogleOAuthUrl,
  exchangeGoogleAuthCode,
  exportGoogleDocAsMarkdown,
  normalizeGoogleDocId,
  refreshGoogleAccessToken,
} from '../src/career/lib/googleDocs.mjs';

const originalFetch = globalThis.fetch;
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('PASS:', name);
    passed += 1;
  } catch (err) {
    console.error('FAIL:', name);
    console.error(err);
    process.exit(1);
  }
}

function mockFetch(fn) {
  globalThis.fetch = fn;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

await test('1. normalizeGoogleDocId accepts bare doc IDs', () => {
  assert.equal(
    normalizeGoogleDocId('1AbCdEfGhIjKlMnOpQrStUvWxYz-1234567890'),
    '1AbCdEfGhIjKlMnOpQrStUvWxYz-1234567890'
  );
});

await test('2. normalizeGoogleDocId extracts IDs from docs URLs', () => {
  const out = normalizeGoogleDocId('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz-1234567890/edit?usp=sharing');
  assert.equal(out, '1AbCdEfGhIjKlMnOpQrStUvWxYz-1234567890');
});

await test('3. buildGoogleOAuthUrl includes offline-consent parameters', () => {
  const url = new URL(buildGoogleOAuthUrl({
    clientId: 'client-123',
    redirectUri: 'http://localhost:4568/api/career/google/oauth/callback',
    state: 'state-xyz',
  }));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:4568/api/career/google/oauth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'state-xyz');
  assert.match(url.searchParams.get('scope') || '', /drive\.readonly/);
});

await test('4. exchangeGoogleAuthCode posts form data and returns JSON', async () => {
  mockFetch(async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const body = options.body.toString();
    assert.match(body, /grant_type=authorization_code/);
    assert.match(body, /code=auth-code/);
    return new Response(JSON.stringify({
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      token_type: 'Bearer',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const out = await exchangeGoogleAuthCode({
    clientId: 'client-123',
    clientSecret: 'secret-123',
    redirectUri: 'http://localhost:4568/api/career/google/oauth/callback',
    code: 'auth-code',
  });
  assert.equal(out.refresh_token, 'refresh-123');
  restoreFetch();
});

await test('5. refreshGoogleAccessToken surfaces invalid_grant', async () => {
  mockFetch(async () => new Response(JSON.stringify({
    error: 'invalid_grant',
    error_description: 'Token has been expired or revoked.',
  }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  }));

  await assert.rejects(
    refreshGoogleAccessToken({
      clientId: 'client-123',
      clientSecret: 'secret-123',
      refreshToken: 'refresh-123',
    }),
    err => err.google_error === 'invalid_grant' && /expired or revoked/i.test(err.message),
  );
  restoreFetch();
});

await test('6. exportGoogleDocAsMarkdown returns exported markdown', async () => {
  mockFetch(async (url, options) => {
    assert.match(String(url), /drive\/v3\/files\/doc-123\/export/);
    assert.equal(options.headers.Authorization, 'Bearer access-123');
    return new Response('# Resume\n\n## Experience\n', { status: 200 });
  });

  const out = await exportGoogleDocAsMarkdown({
    accessToken: 'access-123',
    docId: 'doc-123',
  });
  assert.match(out, /# Resume/);
  restoreFetch();
});

restoreFetch();
console.log(`\n✅ All ${passed} smoke tests passed.`);
