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

export const PortalsFileSchema = z.object({
  sources: z.array(SourceConfigSchema).default([]),
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
  const parsed = PortalsFileSchema.parse(data);
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
