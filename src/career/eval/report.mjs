// Report formatters for eval runner output.
//
// 07-applier/self-iteration/01-code-calibration m2.
//
// Two formats:
//   - JSON       — structured artefact for m3 tuner consumption + CI diffing
//   - Console    — human-readable table with per-fixture breakdown

const BAR_WIDTH = 20;

/**
 * Build the JSON artefact for an eval run. Stable shape — m3 reads it.
 *
 * @param {Array<import('./runner.mjs').FixtureResult>} results
 * @param {ReturnType<typeof import('./runner.mjs').aggregate>} summary
 */
export function buildJsonReport(results, summary) {
  // REVIEW L2 (adv) fix [EH1 determinism]: allow SOURCE_DATE_EPOCH
  // override so two eval runs over identical inputs produce identical
  // JSON output (CI diffing, m3 tuner reproducibility). Honors the
  // Reproducible Builds convention (https://reproducible-builds.org/).
  const epochOverride = process.env.SOURCE_DATE_EPOCH;
  const generated_at =
    epochOverride && /^\d+$/.test(epochOverride)
      ? new Date(Number(epochOverride) * 1000).toISOString()
      : new Date().toISOString();
  return {
    schema_version: 1,
    generated_at,
    summary: {
      n: summary.n,
      aggregate_min: summary.min,
      aggregate_mean: summary.mean,
      per_fixture: summary.perFixture,
    },
    fixtures: results.map((r) => ({
      id: r.id,
      vendor: r.vendor,
      page_type: r.page_type,
      nodes_emitted: r.nodes_emitted,
      skipped_frames: r.skipped_frames,
      score: {
        coverage: r.score.coverage,
        noise_rate: r.score.noise_rate,
        aria_accuracy: r.score.aria_accuracy,
        aggregate: r.score.aggregate,
        counts: r.score.counts,
      },
      detail: r.score.detail,
    })),
  };
}

/**
 * Render a console-friendly table. Single string return so the caller
 * can write to stdout or a file.
 */
export function formatConsoleReport(results, summary) {
  const lines = [];
  lines.push('');
  lines.push('Eval Snapshot — per-fixture scores');
  lines.push('═'.repeat(76));
  lines.push(
    pad('FIXTURE', 26) +
      pad('COV', 8, 'right') +
      pad('NOISE', 8, 'right') +
      pad('ARIA', 8, 'right') +
      pad('AGG', 10, 'right') +
      '  BAR',
  );
  lines.push('─'.repeat(76));
  for (const r of results) {
    const s = r.score;
    lines.push(
      pad(r.id, 26) +
        pad(pct(s.coverage), 8, 'right') +
        pad(pct(s.noise_rate), 8, 'right') +
        pad(pct(s.aria_accuracy), 8, 'right') +
        pad(pct(s.aggregate), 10, 'right') +
        '  ' +
        bar(s.aggregate),
    );
  }
  lines.push('─'.repeat(76));
  lines.push(
    pad('SUMMARY (n=' + summary.n + ')', 26) +
      pad('', 8) +
      pad('', 8) +
      pad('', 8) +
      pad(`min=${pct(summary.min)}`, 14, 'right') +
      `  mean=${pct(summary.mean)}`,
  );
  lines.push('');

  // Per-fixture detail blocks — only if there's something interesting to show.
  for (const r of results) {
    const d = r.score.detail;
    if (
      d.missing.length === 0 &&
      d.role_mismatch.length === 0 &&
      d.out_of_allowlist.length === 0 &&
      d.leaked.length === 0 &&
      d.aria_errors.length === 0
    ) {
      continue;
    }
    lines.push(`${r.id} — issues:`);
    for (const m of d.role_mismatch) {
      lines.push(
        `  · role_mismatch: name="${m.expected.name}" expected role=${m.expected.role} but saw ${m.observed.role}`,
      );
    }
    for (const m of d.out_of_allowlist) {
      lines.push(
        `  · out_of_allowlist: name="${m.name}" truth role="${m.role}" (∉ snapshot INTERACTIVE_ROLES) — tuner candidate`,
      );
    }
    for (const m of d.missing) {
      // role_mismatch + out_of_allowlist both ALSO push to missing for
      // coverage; skip those here to keep the report tight.
      if (d.role_mismatch.some((x) => x.expected.name === m.name && x.expected.role === m.role)) {
        continue;
      }
      if (d.out_of_allowlist.some((x) => x.name === m.name && x.role === m.role)) {
        continue;
      }
      lines.push(`  · missing: ${m.role} "${m.name}"`);
    }
    for (const m of d.leaked) {
      lines.push(`  · leaked: "${m.name}" (banned because: ${m.reason})`);
    }
    for (const a of d.aria_errors) {
      lines.push(
        `  · aria: "${a.name}" missing states [${a.missing_states.join(', ')}]; observed [${a.observed_states.join(', ') || '—'}]`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function pad(s, width, align = 'left') {
  s = String(s);
  if (s.length >= width) return s.slice(0, width);
  const fill = ' '.repeat(width - s.length);
  return align === 'right' ? fill + s : s + fill;
}

function pct(n) {
  if (!Number.isFinite(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}

function bar(n) {
  if (!Number.isFinite(n)) return '';
  const filled = Math.round(Math.max(0, Math.min(1, n)) * BAR_WIDTH);
  return '█'.repeat(filled) + '·'.repeat(BAR_WIDTH - filled);
}
