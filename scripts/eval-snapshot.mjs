#!/usr/bin/env node
// Eval-snapshot CLI — run the eval harness against every fixture in
// data/career/eval-fixtures/ and print a report.
//
// 07-applier/self-iteration/01-code-calibration m2.
//
// Usage:
//   node scripts/eval-snapshot.mjs                     # default — prints console report
//   node scripts/eval-snapshot.mjs --json              # JSON to stdout
//   node scripts/eval-snapshot.mjs --threshold 0.6     # exit non-zero if min < threshold
//   node scripts/eval-snapshot.mjs --out report.json   # also write JSON artefact
//
// Exit codes:
//   0 — eval ran; aggregate min ≥ threshold (default 0.0, i.e. no gate)
//   1 — eval failed (Playwright error, fixture load error, etc.)
//   2 — eval ran but aggregate min < threshold (CI gate signal)

import { promises as fs } from 'node:fs';
import { loadFixtures, DEFAULT_FIXTURES_DIR } from '../src/career/eval/fixtures/loader.mjs';
import { evalRegistry } from '../src/career/eval/runner.mjs';
import { buildJsonReport, formatConsoleReport } from '../src/career/eval/report.mjs';

function parseArgs(argv) {
  const out = { json: false, threshold: 0, out: null, dir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--threshold') out.threshold = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!Number.isFinite(out.threshold) || out.threshold < 0 || out.threshold > 1) {
    throw new Error(`--threshold must be in [0,1], got ${out.threshold}`);
  }
  return out;
}

function usage() {
  console.error(`Usage:
  node scripts/eval-snapshot.mjs [--dir <fixtures-dir>] [--json] [--threshold <0..1>] [--out <file.json>]

Runs snapshot.mjs against every fixture pair under data/career/eval-fixtures/
(or --dir) and scores each against its ground-truth YAML. Aggregate uses
min across fixtures (Q2 locked: pessimistic — defends worst ATS).`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }
  const dir = args.dir || DEFAULT_FIXTURES_DIR;
  const registry = await loadFixtures(dir);
  if (registry.fixtures.length === 0) {
    console.error(`No fixtures found in ${dir}. Use scripts/capture-fixture.mjs to add one.`);
    process.exit(1);
  }

  const { results, summary } = await evalRegistry(registry);
  const jsonReport = buildJsonReport(results, summary);

  if (args.out) {
    await fs.writeFile(args.out, JSON.stringify(jsonReport, null, 2), 'utf8');
    console.error(`Wrote JSON report to ${args.out}`);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(jsonReport, null, 2) + '\n');
  } else {
    process.stdout.write(formatConsoleReport(results, summary) + '\n');
  }

  if (summary.min < args.threshold) {
    console.error(
      `\n✗ aggregate min ${(summary.min * 100).toFixed(1)}% below threshold ${(args.threshold * 100).toFixed(1)}%`,
    );
    // REVIEW C1 (adv) fix: setting process.exitCode + returning lets
    // the event loop drain stdout/stderr before exit. process.exit(2)
    // here would truncate JSON output piped through `| jq` on Linux/Mac
    // where stdout-to-pipe is async — surfacing as nondeterministic CI
    // failures. Exit code 2 distinguishes "ran but below threshold"
    // from exit 1 ("eval pipeline crashed").
    process.exitCode = 2;
    return;
  }
}

main().catch((err) => {
  console.error('eval-snapshot failed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
