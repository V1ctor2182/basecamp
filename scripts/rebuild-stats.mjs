// Rebuild Claude usage stats from ~/.claude/projects session JSONL files
// Includes subagent files for full token/cost accuracy
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { execSync } from 'child_process';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const OUTPUT_FILE = path.join(path.dirname(import.meta.dirname), 'data', 'claude-stats.json');

// Collect all JSONL files recursively under a project dir
async function collectJsonlFiles(dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectJsonlFiles(full));
    } else if (entry.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

async function scanSessions() {
  // Token + cost data comes from ccusage (live LiteLLM pricing).
  // This script still owns: dailyActivity, hourCounts, sessions, longestSession.

  const dailyActivity = {};   // date -> { messages, sessions Set, toolCalls }
  const hourCounts = {};      // hour -> count (local time)
  const sessions = new Set();
  let firstDate = null;
  const sessionMeta = {};     // sessionId -> { start, end, messageCount }

  const projectDirs = await fs.readdir(PROJECTS_DIR).catch(() => []);

  for (const projDir of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, projDir);
    const stat = await fs.stat(projPath).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const files = await collectJsonlFiles(projPath);

    for (const filePath of files) {
      // Use filename (without .jsonl) as session identifier for top-level files
      const sessionId = path.basename(filePath, '.jsonl');
      const isSubagent = filePath.includes('/subagents/');

      try {
        const rl = createInterface({
          input: createReadStream(filePath),
          crlfDelay: Infinity,
        });

        for await (const line of rl) {
          if (!line.trim()) continue;
          let record;
          try { record = JSON.parse(line); } catch { continue; }

          const ts = record.timestamp;
          if (!ts) continue;

          const localDate = new Date(ts);
          const date = `${localDate.getFullYear()}-${String(localDate.getMonth()+1).padStart(2,'0')}-${String(localDate.getDate()).padStart(2,'0')}`;
          const hour = localDate.getHours();

          if (record.type === 'user' && record.userType === 'external' && !isSubagent) {
            sessions.add(sessionId);
            if (!dailyActivity[date]) dailyActivity[date] = { messages: 0, sessions: new Set(), toolCalls: 0 };
            dailyActivity[date].sessions.add(sessionId);

            if (!sessionMeta[sessionId]) {
              sessionMeta[sessionId] = { start: ts, end: ts, messageCount: 0 };
            }
            sessionMeta[sessionId].messageCount++;
            sessionMeta[sessionId].end = ts;

            if (!firstDate || date < firstDate) firstDate = date;
          }

          if (record.type === 'assistant') {
            if (!dailyActivity[date]) dailyActivity[date] = { messages: 0, sessions: new Set(), toolCalls: 0 };
            dailyActivity[date].messages++;
            hourCounts[hour] = (hourCounts[hour] || 0) + 1;

            // Count tool calls
            const msg = record.message || {};
            if (msg.content && Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === 'tool_use') {
                  dailyActivity[date].toolCalls++;
                }
              }
            }
          }
        }
      } catch (e) {
        // Skip unreadable files
      }
    }
  }

  const sortedDates = Object.keys(dailyActivity).sort();
  const dailyActivityArr = sortedDates.map(date => ({
    date,
    messageCount: dailyActivity[date].messages,
    sessionCount: dailyActivity[date].sessions.size,
    toolCallCount: dailyActivity[date].toolCalls,
  }));

  let longestSession = null;
  for (const [sid, meta] of Object.entries(sessionMeta)) {
    const duration = new Date(meta.end) - new Date(meta.start);
    if (!longestSession || duration > longestSession.duration) {
      longestSession = { sessionId: sid, duration, messageCount: meta.messageCount, timestamp: meta.start };
    }
  }

  // Use earliest date from any activity (not just user messages)
  const earliestDate = sortedDates.length > 0 ? sortedDates[0] : firstDate;
  const firstSessionDate = earliestDate || null;

  // Pull token + cost data from ccusage (live LiteLLM pricing — no manual price table)
  let ccusageJson;
  try {
    const ccusageBin = path.join(path.dirname(import.meta.dirname), 'node_modules', '.bin', 'ccusage');
    const ccusageCmd = existsSync(ccusageBin) ? ccusageBin : 'ccusage';
    const out = execSync(`${ccusageCmd} daily --json`, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    ccusageJson = JSON.parse(out);
  } catch (e) {
    console.error('ccusage failed — run `npm install` to install it');
    throw e;
  }

  const dailyModelTokensArr = ccusageJson.daily.map(d => ({
    date: d.date,
    tokensByModel: Object.fromEntries(
      d.modelBreakdowns.map(m => [
        m.modelName,
        m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens,
      ]),
    ),
  }));

  const dailyCostArr = ccusageJson.daily.map(d => ({
    date: d.date,
    costByModel: Object.fromEntries(d.modelBreakdowns.map(m => [m.modelName, m.cost])),
  }));

  const modelUsage = {};
  for (const day of ccusageJson.daily) {
    for (const m of day.modelBreakdowns) {
      if (!modelUsage[m.modelName]) {
        modelUsage[m.modelName] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
          webSearchRequests: 0,
          contextWindow: 0,
          maxOutputTokens: 0,
        };
      }
      const u = modelUsage[m.modelName];
      u.inputTokens += m.inputTokens;
      u.outputTokens += m.outputTokens;
      u.cacheReadInputTokens += m.cacheReadTokens;
      u.cacheCreationInputTokens += m.cacheCreationTokens;
      u.costUSD += m.cost;
    }
  }

  const totalCost = ccusageJson.totals.totalCost;

  const result = {
    version: 4,
    lastComputedDate: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })(),
    dailyActivity: dailyActivityArr,
    dailyModelTokens: dailyModelTokensArr,
    dailyCost: dailyCostArr,
    modelUsage,
    totalSessions: sessions.size,
    totalMessages: dailyActivityArr.reduce((s, d) => s + d.messageCount, 0),
    totalCostUSD: totalCost,
    longestSession,
    firstSessionDate,
    hourCounts,
    totalSpeculationTimeSavedMs: 0,
    shotDistribution: {},
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(result), 'utf-8');

  console.log(`Stats rebuilt: ${sessions.size} sessions, ${result.totalMessages} messages, ${sortedDates.length} days`);
  console.log(`Models (from ccusage): ${Object.keys(modelUsage).join(', ')}`);
  console.log(`Total cost (from ccusage): $${totalCost.toFixed(2)}`);
  console.log(`Saved to ${OUTPUT_FILE}`);
}

scanSessions().catch(console.error);
