#!/usr/bin/env node
// Smoke for 08-human-gate-tracker/01-application-state m1: applications
// store module. Pure-Node asserts — no server spawn, no API calls. Exercises
// the schema, state machine, atomic writes, and append-only invariants.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  APPLICATION_ID_RE,
  STATUS_VALUES,
  LEGITIMACY_VALUES,
  VALID_TRANSITIONS,
  STATUS_RANK,
  ApplicationSchema,
  ApplicationsArraySchema,
  TimelineEventSchema,
  InvalidTransitionError,
  ApplicationNotFoundError,
  TimelineOrderError,
  readApplications,
  writeApplications,
  upsertApplication,
  transitionStatus,
  appendTimelineEvent,
  APPLICATIONS_FILE,
} from '../src/career/applications/store.mjs';

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

// ── Set up an isolated test fixture by backing up + clearing applications.json
const SUFFIX = `.smoke-backup.${process.pid}`;
let hadOriginal = false;
if (existsSync(APPLICATIONS_FILE)) {
  await fs.copyFile(APPLICATIONS_FILE, APPLICATIONS_FILE + SUFFIX);
  hadOriginal = true;
}
// Start fresh — every test reads from the live file.
await fs.unlink(APPLICATIONS_FILE).catch(() => {});

async function cleanup() {
  await fs.unlink(APPLICATIONS_FILE).catch(() => {});
  if (hadOriginal) {
    await fs.rename(APPLICATIONS_FILE + SUFFIX, APPLICATIONS_FILE).catch(() => {});
  }
}

function makeRow(over = {}) {
  return {
    id: 'aaaaaaaaaaaa-20260508',
    company: 'Anthropic',
    role: 'Senior Backend Engineer',
    url: 'https://example.com/jobs/abc',
    score: 4.5,
    status: 'Evaluated',
    legitimacy: 'Unknown',
    reportPath: 'data/career/reports/aaaaaaaaaaaa.md',
    pdfPath: null,
    resumeId: null,
    timeline: [{ ts: '2026-05-08T10:00:00Z', event: 'created' }],
    ...over,
  };
}

try {
  // ── 1. Schema basics ───────────────────────────────────────────────────
  await test('ApplicationSchema accepts a valid row', () => {
    const r = ApplicationSchema.parse(makeRow());
    assert.equal(r.id, 'aaaaaaaaaaaa-20260508');
    assert.equal(r.legitimacy, 'Unknown');
  });

  await test('ApplicationSchema rejects bad id (wrong regex)', () => {
    assert.throws(() => ApplicationSchema.parse(makeRow({ id: 'bad-id' })), /id must match/);
    assert.throws(() => ApplicationSchema.parse(makeRow({ id: 'AAAAAAAAAAAA-20260508' })));
    // jobId portion must be 12 hex; 11 char fails
    assert.throws(() => ApplicationSchema.parse(makeRow({ id: 'aaaaaaaaaaa-20260508' })));
    // YYYYMMDD must be exactly 8 digits
    assert.throws(() => ApplicationSchema.parse(makeRow({ id: 'aaaaaaaaaaaa-2026' })));
  });

  await test('ApplicationSchema rejects unknown status / legitimacy', () => {
    assert.throws(() => ApplicationSchema.parse(makeRow({ status: 'Pending' })));
    assert.throws(() => ApplicationSchema.parse(makeRow({ legitimacy: 'Maybe' })));
  });

  await test('ApplicationSchema rejects empty timeline', () => {
    assert.throws(() => ApplicationSchema.parse(makeRow({ timeline: [] })));
  });

  await test('ApplicationsArraySchema rejects array with one bad row', () => {
    const arr = [makeRow(), makeRow({ id: 'aaaaaaaaaaab-20260509', status: 'Pending' })];
    assert.throws(() => ApplicationsArraySchema.parse(arr));
  });

  // ── 2. STATUS_VALUES + VALID_TRANSITIONS shape ─────────────────────────
  await test('Constants are frozen and have expected shape', () => {
    assert.ok(Object.isFrozen(STATUS_VALUES));
    assert.ok(Object.isFrozen(VALID_TRANSITIONS));
    assert.ok(Object.isFrozen(STATUS_RANK));
    assert.equal(STATUS_VALUES.length, 8);
    assert.equal(LEGITIMACY_VALUES.length, 4);
    // Discarded is terminal
    assert.deepEqual([...VALID_TRANSITIONS.Discarded], []);
    // Offer→Rejected for declined offers
    assert.ok(VALID_TRANSITIONS.Offer.includes('Rejected'));
    // Discarded reachable from EVERY non-terminal status
    for (const s of STATUS_VALUES) {
      if (s === 'Discarded') continue;
      assert.ok(
        VALID_TRANSITIONS[s].includes('Discarded'),
        `${s} must allow → Discarded`
      );
    }
    // SKIP reachable from every non-terminal status EXCEPT terminal Discarded
    // (and not from itself — SKIP can only go to Discarded).
    for (const s of ['Evaluated', 'Applied', 'Responded', 'Interview']) {
      assert.ok(VALID_TRANSITIONS[s].includes('SKIP'), `${s} must allow → SKIP`);
    }
  });

  // ── 3. upsertApplication: create new ───────────────────────────────────
  await test('upsertApplication creates new row with creation event', async () => {
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    const r = await upsertApplication({
      id: 'bbbbbbbbbbbb-20260508',
      company: 'OpenAI',
      role: 'Researcher',
      url: 'https://example.com/jobs/x',
      score: 4.2,
      status: 'Evaluated',
      reportPath: 'data/career/reports/bbbbbbbbbbbb.md',
    });
    assert.equal(r.id, 'bbbbbbbbbbbb-20260508');
    assert.equal(r.status, 'Evaluated');
    assert.equal(r.timeline.length, 1);
    assert.equal(r.timeline[0].event, 'created');
    assert.equal(r.legitimacy, 'Unknown'); // default

    const persisted = await readApplications();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, 'bbbbbbbbbbbb-20260508');
  });

  // ── 4. upsertApplication idempotency: existing row preserved ───────────
  await test('upsertApplication is idempotent when row exists at any status', async () => {
    // Set up: create at Evaluated, transition to Applied
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    await upsertApplication({
      id: 'cccccccccccc-20260508',
      company: 'A', role: 'r', url: 'u', score: 4.0, status: 'Evaluated',
    });
    await transitionStatus('cccccccccccc-20260508', 'Applied');

    // Re-upsert with conflicting status — should be no-op (preserve Applied)
    const r = await upsertApplication({
      id: 'cccccccccccc-20260508',
      company: 'B-shouldnt-overwrite',
      role: 'shouldnt', url: 'shouldnt',
      score: 99, status: 'Evaluated',
    });
    assert.equal(r.status, 'Applied', 'idempotency preserves later state');
    assert.equal(r.company, 'A', 'company not overwritten');
    assert.equal(r.timeline.length, 2, 'timeline not appended on no-op');
  });

  // ── 5. transitionStatus: legal transitions ─────────────────────────────
  await test('transitionStatus Evaluated→Applied appends event with from/to', async () => {
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    await upsertApplication({
      id: 'dddddddddddd-20260508',
      company: 'A', role: 'r', url: 'u', score: 4.0, status: 'Evaluated',
    });
    const r = await transitionStatus('dddddddddddd-20260508', 'Applied', 'submitted via Workday');
    assert.equal(r.status, 'Applied');
    assert.equal(r.timeline.length, 2);
    const ev = r.timeline[1];
    assert.equal(ev.event, 'status_changed');
    assert.equal(ev.from, 'Evaluated');
    assert.equal(ev.to, 'Applied');
    assert.equal(ev.note, 'submitted via Workday');
  });

  // ── 6. transitionStatus: illegal jumps throw ───────────────────────────
  await test('transitionStatus rejects illegal jumps with allowed_next info', async () => {
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    await upsertApplication({
      id: 'eeeeeeeeeeee-20260508',
      company: 'A', role: 'r', url: 'u', score: 4.0, status: 'Evaluated',
    });
    let err;
    try {
      await transitionStatus('eeeeeeeeeeee-20260508', 'Interview');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof InvalidTransitionError);
    assert.equal(err.current_status, 'Evaluated');
    assert.deepEqual(err.allowed_next.sort(), ['Applied', 'Discarded', 'SKIP'].sort());
  });

  // ── 7. Discarded reachable from every non-terminal status ──────────────
  await test('Discarded is a terminal-from-any-non-terminal sink', async () => {
    for (const startStatus of ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'SKIP']) {
      await fs.unlink(APPLICATIONS_FILE).catch(() => {});
      await upsertApplication({
        id: 'ffffffffffff-20260508',
        company: 'A', role: 'r', url: 'u', score: 4.0, status: startStatus,
      });
      const r = await transitionStatus('ffffffffffff-20260508', 'Discarded');
      assert.equal(r.status, 'Discarded', `${startStatus} → Discarded must succeed`);
    }
  });

  // ── 8. SKIP reachable from non-terminal earlier states ─────────────────
  await test('SKIP reachable from Evaluated/Applied/Responded/Interview only', async () => {
    for (const startStatus of ['Evaluated', 'Applied', 'Responded', 'Interview']) {
      await fs.unlink(APPLICATIONS_FILE).catch(() => {});
      await upsertApplication({
        id: '111111111111-20260508',
        company: 'A', role: 'r', url: 'u', score: 4.0, status: startStatus,
      });
      const r = await transitionStatus('111111111111-20260508', 'SKIP');
      assert.equal(r.status, 'SKIP');
    }
    // Offer → SKIP is NOT allowed (Offer can only go to Rejected/Discarded)
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    await upsertApplication({
      id: '222222222222-20260508',
      company: 'A', role: 'r', url: 'u', score: 4.0, status: 'Offer',
    });
    await assert.rejects(
      transitionStatus('222222222222-20260508', 'SKIP'),
      InvalidTransitionError
    );
  });

  // ── 9. Offer→Rejected (declined offer) ─────────────────────────────────
  await test('Offer→Rejected allowed (declined offer scenario)', async () => {
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    await upsertApplication({
      id: '333333333333-20260508',
      company: 'A', role: 'r', url: 'u', score: 4.0, status: 'Offer',
    });
    const r = await transitionStatus('333333333333-20260508', 'Rejected', 'declined offer — base too low');
    assert.equal(r.status, 'Rejected');
    assert.equal(r.timeline[r.timeline.length - 1].note, 'declined offer — base too low');
  });

  // ── 10. Discarded is terminal (no transitions out) ─────────────────────
  await test('Discarded is terminal — every transition out throws', async () => {
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    await upsertApplication({
      id: '444444444444-20260508',
      company: 'A', role: 'r', url: 'u', score: 4.0, status: 'Discarded',
    });
    for (const target of STATUS_VALUES.filter((s) => s !== 'Discarded')) {
      await assert.rejects(
        transitionStatus('444444444444-20260508', target),
        InvalidTransitionError,
        `Discarded → ${target} must throw`
      );
    }
  });

  // ── 11. appendTimelineEvent: append-only invariant ─────────────────────
  await test('appendTimelineEvent rejects backdated timestamps', async () => {
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    await upsertApplication({
      id: '555555555555-20260508',
      company: 'A', role: 'r', url: 'u', score: 4.0, status: 'Evaluated',
    });
    // Get the row — its 'created' event is at "now". Try to append a backdated event.
    const backdatedTs = '2020-01-01T00:00:00Z';
    await assert.rejects(
      appendTimelineEvent('555555555555-20260508', {
        ts: backdatedTs, event: 'note', note: 'too old',
      }),
      TimelineOrderError
    );
    // Forward-dated note should succeed
    const forwardTs = new Date(Date.now() + 60_000).toISOString();
    const r = await appendTimelineEvent('555555555555-20260508', {
      ts: forwardTs, event: 'note', note: 'a forward note',
    });
    assert.equal(r.timeline.length, 2);
    assert.equal(r.timeline[1].event, 'note');
  });

  // ── 12. appendTimelineEvent rejects reserved internal events ───────────
  await test('appendTimelineEvent rejects status_changed + created (reserved internal)', async () => {
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    await upsertApplication({
      id: '666666666666-20260508',
      company: 'A', role: 'r', url: 'u', score: 4.0, status: 'Evaluated',
    });
    // status_changed events must use transitionStatus
    await assert.rejects(
      appendTimelineEvent('666666666666-20260508', {
        ts: new Date(Date.now() + 60_000).toISOString(),
        event: 'status_changed',
        from: 'Evaluated',
        to: 'Applied',
      }),
      /emitted internally/
    );
    // 'created' is reserved for upsertApplication's initial event — caller
    // can't synthesize a second creation
    await assert.rejects(
      appendTimelineEvent('666666666666-20260508', {
        ts: new Date(Date.now() + 60_000).toISOString(),
        event: 'created',
      }),
      /emitted internally/
    );
  });

  // ── 13. ApplicationNotFoundError ───────────────────────────────────────
  await test('transitionStatus throws ApplicationNotFoundError on missing id', async () => {
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    await assert.rejects(
      transitionStatus('777777777777-20260508', 'Applied'),
      ApplicationNotFoundError
    );
  });

  // ── 14. Atomic write: tmp file unlinked on schema-validation error ─────
  // If writeApplications fails (e.g. schema violation), the .tmp file
  // shouldn't accumulate on disk. atomicWriteJson catches + unlinks.
  await test('Schema-violation write does not leave .tmp orphans', async () => {
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    // Try writing an invalid row directly (bypassing upsert helpers)
    await assert.rejects(
      writeApplications([{ id: 'bad-id', company: 'A' }]), // missing required fields
    );
    // Scan data/career/ for any .tmp files left behind
    const dir = path.dirname(APPLICATIONS_FILE);
    const files = await fs.readdir(dir);
    const orphans = files.filter((f) => f.startsWith('applications.json.tmp'));
    assert.equal(orphans.length, 0, `expected no .tmp orphans, found: ${orphans}`);
  });

  // ── 15. STATUS_RANK ordering ───────────────────────────────────────────
  await test('STATUS_RANK orders normal flow ascending; archives high', () => {
    assert.ok(STATUS_RANK.Evaluated < STATUS_RANK.Applied);
    assert.ok(STATUS_RANK.Applied < STATUS_RANK.Responded);
    assert.ok(STATUS_RANK.Responded < STATUS_RANK.Interview);
    assert.ok(STATUS_RANK.Interview < STATUS_RANK.Offer);
    assert.ok(STATUS_RANK.Offer < STATUS_RANK.Rejected);
    assert.ok(STATUS_RANK.Rejected < STATUS_RANK.Discarded);
    assert.equal(STATUS_RANK.Discarded, STATUS_RANK.SKIP);
  });

  // ── 16. readApplications: ENOENT → [] ──────────────────────────────────
  await test('readApplications returns [] when file does not exist', async () => {
    await fs.unlink(APPLICATIONS_FILE).catch(() => {});
    const arr = await readApplications();
    assert.deepEqual(arr, []);
  });
} finally {
  await cleanup();
}

console.log(`\n✅ All ${passed} smoke tests passed.`);
