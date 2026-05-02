import { z } from 'zod';
import yaml from 'js-yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

import { SOURCE_TYPES } from '../lib/jobSchema.mjs';

export const SourceConfigSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  name: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(1).max(10).optional(),
});

// scan_cadence is read by the scheduler (05-scan-scheduler) to decide when
// each source type is due. Values are duration strings ("72h" / "24h" / etc.)
// — strict format validated by cadenceState.parseCadence at read-time, not
// here, so a malformed cadence for one type doesn't reject the whole portals
// config (the scheduler logs + skips that type instead).
export const PortalsFileSchema = z.object({
  sources: z.array(SourceConfigSchema).default([]),
  scan_cadence: z.record(z.string(), z.string()).optional().default({}),
});

const DATA_DIR = path.resolve('data');
const CAREER_DIR = path.join(DATA_DIR, 'career');
export const PORTALS_FILE = path.join(CAREER_DIR, 'portals.yml');

export async function readPortalsConfig() {
  if (!existsSync(PORTALS_FILE)) return { sources: [] };
  const raw = await fs.readFile(PORTALS_FILE, 'utf-8');
  if (!raw.trim()) return { sources: [] };
  let parsed;
  try {
    parsed = yaml.load(raw) ?? {};
  } catch (e) {
    throw new Error(`portals.yml parse error: ${e.message}`);
  }
  return PortalsFileSchema.parse(parsed);
}

export async function writePortalsConfig(data) {
  // Preserve scan_cadence on partial writes. The Portals UI shipped before
  // m1 of 05-scan-scheduler — its PUT bodies don't include scan_cadence.
  // Without this read-modify-merge, a single Save click would silently
  // wipe the cadence config and break the scheduler. To EXPLICITLY clear
  // cadence, callers must pass `scan_cadence: {}`.
  let merged = data;
  if (data && typeof data === 'object' && !('scan_cadence' in data)) {
    try {
      const existing = await readPortalsConfig();
      if (existing.scan_cadence && Object.keys(existing.scan_cadence).length > 0) {
        merged = { ...data, scan_cadence: existing.scan_cadence };
      }
    } catch {
      // existing file unreadable → fall through to default {}
    }
  }
  const parsed = PortalsFileSchema.parse(merged);
  if (!existsSync(CAREER_DIR)) {
    await fs.mkdir(CAREER_DIR, { recursive: true });
  }
  const yamlStr = yaml.dump(parsed, { lineWidth: 120 });
  const tmp = `${PORTALS_FILE}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmp, yamlStr);
    await fs.rename(tmp, PORTALS_FILE);
  } catch (e) {
    fs.unlink(tmp).catch(() => {});
    throw e;
  }
}
