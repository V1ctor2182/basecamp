#!/usr/bin/env node
// Auto-tuner CLI — run the deterministic search against every fixture
// in data/career/eval-fixtures/, write the proposed allowlist diff +
// iteration log for human review.
//
// 07-applier/self-iteration/01-code-calibration m3.
//
// EH5 enforced: this NEVER mutates snapshot.mjs. It writes a unified
// diff to `data/career/eval-fixtures/proposed-allowlist.diff` (or
// `--out`) — the operator reviews it, runs smoke + eval, then manually
// edits snapshot.mjs INTERACTIVE_ROLES.
//
// Usage:
//   node scripts/tune-snapshot.mjs                          # default paths
//   node scripts/tune-snapshot.mjs --dir <fixtures>         # alt fixtures dir
//   node scripts/tune-snapshot.mjs --max-iter 30            # acceptance (d) default = 20
//   node scripts/tune-snapshot.mjs --regression 0.10        # alt EH2 threshold
//   node scripts/tune-snapshot.mjs --out path/to/diff.txt
//   node scripts/tune-snapshot.mjs --log path/to/log.json
//   node scripts/tune-snapshot.mjs --json                   # log to stdout (no file)

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DEFAULT_FIXTURES_DIR } from '../src/career/eval/fixtures/loader.mjs';
import { tune } from '../src/career/eval/tuner.mjs';

// REVIEW M6 (Plan) fix: rename .diff → .txt since the format is NOT a
// real unified diff (no line ranges, sorted union not file-anchored).
// The file is a human-review aid, not a `git apply`-able patch.
const DEFAULT_DIFF_OUT = path.join(DEFAULT_FIXTURES_DIR, 'proposed-allowlist.txt');
const DEFAULT_LOG_OUT = path.join(DEFAULT_FIXTURES_DIR, 'tuner-log.json');

// REVIEW C2 (adv) fix [CRITICAL EH5 enforcement]: tuner output writes
// MUST stay under data/career/eval-fixtures/ (or an explicit --allow-
// external-out). Pre-fix `--out src/career/applier/runtime/snapshot.mjs`
// would have overwritten the source — exactly what EH5 forbids.
function validateOutputPath(out, label, allowExternal) {
  const resolved = path.resolve(out);
  const allowed = path.resolve(DEFAULT_FIXTURES_DIR);
  if (resolved === allowed || resolved.startsWith(allowed + path.sep)) return;
  if (allowExternal) return;
  throw new Error(
    `${label} ${out} resolves outside ${DEFAULT_FIXTURES_DIR}. ` +
      `Pass --allow-external-out to write elsewhere (NEVER use to overwrite src/).`,
  );
}

function parseArgs(argv) {
  const out = {
    dir: null,
    maxIter: null,
    regression: null,
    diffOut: DEFAULT_DIFF_OUT,
    logOut: DEFAULT_LOG_OUT,
    json: false,
    allowExternalOut: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const need = (key) => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`Missing value for ${a}`);
      }
      out[key] = v;
    };
    if (a === '--dir') need('dir');
    else if (a === '--max-iter') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 1 || v > 100) {
        throw new Error('--max-iter must be 1..100');
      }
      out.maxIter = v;
    } else if (a === '--regression') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error('--regression must be 0..1');
      }
      out.regression = v;
    } else if (a === '--out') need('diffOut');
    else if (a === '--log') need('logOut');
    else if (a === '--json') out.json = true;
    else if (a === '--allow-external-out') out.allowExternalOut = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function usage() {
  console.error(`Usage:
  node scripts/tune-snapshot.mjs [--dir <fixtures-dir>] [--max-iter N=20]
                                 [--regression T=0.05] [--out diff.txt]
                                 [--log log.json] [--json]

Deterministic greedy auto-tuner (Q3: simple-only candidates). Reads m1
fixtures + m2 eval signals, proposes role-allowlist edits, gates each
on no per-fixture regression > T (EH2), stops at convergence or
--max-iter (EH1 + acceptance d).

Output (EH5 reviewable, never auto-committed):
  --out  unified diff against snapshot.mjs INTERACTIVE_ROLES
  --log  full iteration log with per-fixture deltas`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }
  // REVIEW C2 (adv) fix: validate output paths before launching the
  // (expensive) tuner — fail fast on path traversal.
  validateOutputPath(args.diffOut, '--out', args.allowExternalOut);
  validateOutputPath(args.logOut, '--log', args.allowExternalOut);
  const t0 = Date.now();
  const result = await tune({
    fixturesDir: args.dir ?? undefined,
    maxIterations: args.maxIter ?? undefined,
    regressionThreshold: args.regression ?? undefined,
  });
  const elapsed = Date.now() - t0;

  if (args.json) {
    process.stdout.write(JSON.stringify(result.log, null, 2) + '\n');
  } else {
    await fs.writeFile(args.diffOut, result.diff + '\n', 'utf8');
    await fs.writeFile(args.logOut, JSON.stringify(result.log, null, 2) + '\n', 'utf8');
    const accepted = result.log.iterations.filter((i) => i.decision === 'accepted').length;
    console.log('');
    console.log(`Tuner finished in ${(elapsed / 1000).toFixed(1)}s.`);
    console.log(`  iterations:        ${result.log.iterations.length} (${accepted} accepted)`);
    console.log(`  converged:         ${result.converged}`);
    console.log(`  stalled:           ${result.stalled}`);
    console.log(`  max_iter_reached:  ${result.log.max_iterations_reached}`);
    console.log(`  initial allowlist: [${result.log.initial_allowlist.join(', ')}]`);
    console.log(`  final allowlist:   [${result.log.final_allowlist.join(', ')}]`);
    console.log('');
    console.log(`Wrote ${args.diffOut}`);
    console.log(`Wrote ${args.logOut}`);
    console.log('');
    console.log('EH5: review the diff manually, then edit snapshot.mjs INTERACTIVE_ROLES.');
    console.log('Re-run `node scripts/eval-snapshot.mjs` to verify before committing.');
  }
  // REVIEW M2 (adv) fix: non-convergence + max-iterations-reached signal
  // to CI that tuning didn't terminate cleanly. Exit 0 only on
  // genuine convergence; exit 2 if stalled or maxed-out so the m4 CI
  // gate can flag a tuning regression.
  if (!result.converged) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('tune-snapshot failed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exitCode = 1;
});
