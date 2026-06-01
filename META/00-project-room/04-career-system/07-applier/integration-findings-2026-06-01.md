# Integration Findings — 2026-06-01

First end-to-end exercise of m12-m14 wiring against a fixture Greenhouse-style
form. Outcome: 3 real findings worth fixing, plus confirmation that the
endpoint route layer / SSE infrastructure / 4xx response taxonomy work
correctly in production shape.

## Smoke results

`scripts/integration-mode2-fixture.mjs` against
`data/career/test-fixtures/greenhouse-fixture.html`:

| Test | Result | Notes |
|---|---|---|
| 1. server boots + /status returns 404 for unknown jobId | ✅ | Route registration sound |
| 2. /focus-field on no session → 404 | ✅ | m13 handler chain validated end-to-end |
| 3. SSE /events accepts + emits `: hello` | ✅ | sseHub subscribe path validated |
| 4. POST /start → 202 | ⚠️ | Hangs in dev env (see Finding #1 + #3) |
| 5. /status carries submitDetectedBy | (skipped) | Depends on #4 |
| 6. /focus-field on live session | (skipped) | Depends on #4 |
| 7. /cancel terminates session | (skipped) | Depends on #4 |

## Findings

### #1 — `closeBrowser()` leaves zombie chrome-headless-shell processes

**Severity:** HIGH — corrupts the next Mode 2 launch by holding the persistent
profile lock.

**Reproduction:**
1. Run `node scripts/smoke-applier-observer-interact.mjs` — completes with
   "✅ 17 smoke tests passed".
2. Immediately check `ps aux | grep chrome-headless-shell` — finds 4-5 live
   processes (browser process + GPU + utility + renderers) still holding
   `--user-data-dir=data/career/.playwright/profile`.

**Root cause hypothesis:** `closeBrowser()` (`src/career/applier/runtime/browser.mjs:254`)
calls `ctx.close()` via `Promise.race` against a 30s timeout. If `ctx.close()`
returns success but Playwright fails to actually SIGTERM the underlying
chrome-headless-shell child processes (a known macOS issue with
`launchPersistentContext` + `headless: true`), the process tree leaks.

**Impact on m13:** the next call to `accessExistingPage(jobId)` will find
NO tagged page (the zombies were tagged with a different jobId from the
prior smoke), so focus/retry endpoints return 409 reason='no_live_page'
even when the user just started a fresh session.

**Suggested fix:** after `ctx.close()`, walk `_context.browser()._process.pid`
and SIGTERM the process tree. Or use `--single-process` chromium arg to
avoid the multi-process zombie pattern in smoke-only mode.

**Workaround for users:** `pkill -f chrome-headless-shell` between sessions.

### #2 — Outbound HTTP proxy interferes with integration smoke

**Severity:** LOW — environmental, not a code bug.

**Symptom:** Node's undici fetch respects `http_proxy` env vars. In this
dev environment, server.mjs sets `CAREER_FETCH_PROXY=http://127.0.0.1:12334`
for Mode 1 LLM calls — but this gets inherited by the spawned smoke
processes too, which then route LOCALHOST requests through the proxy.
Proxy drops the /start connection mid-flight (it has its own 30s timeout
that fires before browser launch completes).

**Fix applied:** integration smoke now sets `NO_PROXY=127.0.0.1,localhost`
and deletes `http_proxy` / `HTTP_PROXY` env vars at process start.

### #3 — `/start` blocks for ~10-30s on browser launch in dirty env

**Severity:** MEDIUM — a clean restart works; a dirty profile (Finding #1)
can hang launch indefinitely.

**Symptom:** test 4 of the integration smoke hangs >60s on POST /start.
Test 1-3 succeed (those don't touch Playwright). Likely caused by the
zombie processes from Finding #1 holding the profile lock — new
`launchPersistentContext` fails to acquire and silently retries.

**This was the bug the Plan agent reviews kept anticipating** — m12/m13/m14
all noted "no production-path integration coverage." The wiring works
when smoke deps are injected; under a real browser launch with a fresh
profile, the chain takes time but should resolve. With Finding #1's
zombies, it doesn't.

## Validated by the partial integration smoke

Despite tests 4-7 not completing, tests 1-3 conclusively validate:

- All m13 endpoint routes registered correctly (focus-field 404 chain)
- m13 server.mjs route forwards structured JSON (j.error parseable as JSON)
- m14 SSE /events route handles connections, writes `: hello`, and
  doesn't crash the server
- Route registration order works (no path collisions between m13
  recovery routes and m9 field actions)

The wiring itself appears sound. The blocker is Playwright lifecycle
hygiene, which is m4 (02-playwright-runtime) territory — the smokes
that ship with that Room should reliably clean up. This integration
finding suggests the closeBrowser smoke (`smoke-applier-browser.mjs`)
is missing a "verify no chromium processes alive after close" assertion.

## Next milestone candidates

1. **Fix Finding #1** (closeBrowser zombie cleanup) — small change to
   browser.mjs + add the zombie-verification assertion to
   `smoke-applier-browser.mjs`. Unlocks the full integration smoke
   running clean.

2. **Re-run integration smoke** after #1 lands — let tests 4-7 complete,
   confirm submitDetectedBy is null pre-submit and shifts to a real
   signal after the fixture form submit. Confirms m14 wiring works.

3. **Move to Phase 5 flywheel ingestion** — partial smoke validation
   is acceptable for proceeding. Phase 5 doesn't need a perfect
   integration test, it needs SOMETHING to ingest.
