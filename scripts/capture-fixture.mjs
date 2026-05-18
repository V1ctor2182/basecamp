#!/usr/bin/env node
// CLI wrapper for the eval-fixture capture flow.
//
// 07-applier/self-iteration/01-code-calibration m1.
//
// Usage:
//   node scripts/capture-fixture.mjs \
//     --url   https://boards.greenhouse.io/anthropic/jobs/123 \
//     --vendor greenhouse \
//     --slug   anthropic-eng \
//     [--page-type apply-form] \
//     [--overwrite]
//
// Writes:
//   data/career/eval-fixtures/{vendor}-{slug}.html       (page.content())
//   data/career/eval-fixtures/{vendor}-{slug}.truth.yml  (stub template)
//
// After running, hand-annotate the stub truth.yml then verify it loads:
//   node scripts/smoke-eval-fixtures.mjs

import { captureFromUrl } from '../src/career/eval/fixtures/capture.mjs';

function parseArgs(argv) {
  const out = { overwrite: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--overwrite') {
      out.overwrite = true;
    } else if (a === '--url' || a === '--vendor' || a === '--slug' || a === '--page-type') {
      const key = a.replace(/^--/, '').replace(/-/g, '_');
      const value = argv[++i];
      // REVIEW M4 (adv) fix: reject value that looks like another flag.
      // Pre-fix `--url --vendor x` would assign "--vendor" to url and
      // then complain that vendor was missing.
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${a}`);
      }
      out[key] = value;
    } else if (a === '-h' || a === '--help') {
      out.help = true;
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return out;
}

function usage() {
  console.error(`Usage:
  node scripts/capture-fixture.mjs --url <url> --vendor <slug> --slug <slug> [--page-type <s>] [--overwrite]

Captures an offline HTML snapshot of an ATS apply page + scaffolds a stub
ground-truth YAML for manual annotation (EH3: never LLM-generated).

The captured HTML is what the eval runner (m2) replays via page.setContent.
The truth.yml stub must be filled in by hand — only then will it pass
schema validation (must_detect requires ≥ 1 item).`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }
  for (const required of ['url', 'vendor', 'slug']) {
    if (!args[required]) {
      console.error(`error: --${required} is required\n`);
      usage();
      process.exit(2);
    }
  }

  const result = await captureFromUrl({
    url: args.url,
    vendor: args.vendor,
    slug: args.slug,
    page_type: args.page_type,
    overwrite: args.overwrite,
  });

  console.log(`HTML captured: ${result.htmlPath}`);
  console.log(`Truth scaffold: ${result.truthPath} (${result.truthCreated ? 'created' : 'preserved'})`);
  console.log('\nNext: edit the truth.yml then run `node scripts/smoke-eval-fixtures.mjs` to verify.');
  // Browser singleton is closed inside captureFromUrl (keepBrowserAlive
  // defaults false) so we don't double-close from here.
}

main().catch((err) => {
  console.error('capture-fixture failed:', err.message || err);
  process.exit(1);
});
