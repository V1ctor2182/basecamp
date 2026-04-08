// Rebuild Claude usage stats from ~/.claude/projects session JSONL files
// Includes subagent files for full token/cost accuracy
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const OUTPUT_FILE = path.join(os.homedir(), '.claude', 'stats-cache.json');

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
  const dailyActivity = {};   // date -> { messages, sessions Set, toolCalls }
  const dailyTokens = {};     // date -> { model -> tokens }
  const modelUsage = {};      // model -> { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }
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

            const msg = record.message || {};
            const model = msg.model;
            const usage = msg.usage;

            if (model && usage) {
              // Daily tokens by model
              if (!dailyTokens[date]) dailyTokens[date] = {};
              const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
                + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
              dailyTokens[date][model] = (dailyTokens[date][model] || 0) + totalTokens;

              // Cumulative model usage
              if (!modelUsage[model]) {
                modelUsage[model] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
              }
              modelUsage[model].inputTokens            += usage.input_tokens || 0;
              modelUsage[model].outputTokens           += usage.output_tokens || 0;
              modelUsage[model].cacheReadInputTokens   += usage.cache_read_input_tokens || 0;
              modelUsage[model].cacheCreationInputTokens += usage.cache_creation_input_tokens || 0;
            }

            // Count tool calls
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

  // Compute estimated cost per model (pricing per million tokens)
  const MODEL_PRICING = {
    'claude-opus-4-6':            { input: 15,   output: 75,  cacheRead: 1.875, cacheWrite: 18.75 },
    'claude-opus-4-5-20251101':   { input: 15,   output: 75,  cacheRead: 1.875, cacheWrite: 18.75 },
    'claude-sonnet-4-6':          { input: 3,    output: 15,  cacheRead: 0.375, cacheWrite: 3.75  },
    'claude-sonnet-4-5-20250929': { input: 3,    output: 15,  cacheRead: 0.375, cacheWrite: 3.75  },
    'claude-haiku-4-5-20251001':  { input: 0.80, output: 4,   cacheRead: 0.08,  cacheWrite: 1.0   },
  };

  for (const [model, u] of Object.entries(modelUsage)) {
    const p = MODEL_PRICING[model];
    if (p) {
      u.costUSD = (
        u.inputTokens * p.input +
        u.outputTokens * p.output +
        u.cacheReadInputTokens * p.cacheRead +
        u.cacheCreationInputTokens * p.cacheWrite
      ) / 1_000_000;
    } else {
      u.costUSD = 0;
    }
  }

  const sortedDates = Object.keys(dailyActivity).sort();
  const dailyActivityArr = sortedDates.map(date => ({
    date,
    messageCount: dailyActivity[date].messages,
    sessionCount: dailyActivity[date].sessions.size,
    toolCallCount: dailyActivity[date].toolCalls,
  }));

  const dailyModelTokensArr = Object.keys(dailyTokens).sort().map(date => ({
    date,
    tokensByModel: dailyTokens[date],
  }));

  let longestSession = null;
  for (const [sid, meta] of Object.entries(sessionMeta)) {
    const duration = new Date(meta.end) - new Date(meta.start);
    if (!longestSession || duration > longestSession.duration) {
      longestSession = { sessionId: sid, duration, messageCount: meta.messageCount, timestamp: meta.start };
    }
  }

  const totalCost = Object.values(modelUsage).reduce((s, u) => s + (u.costUSD || 0), 0);

  // Use earliest date from any activity (not just user messages)
  const earliestDate = sortedDates.length > 0 ? sortedDates[0] : firstDate;
  const firstSessionDate = earliestDate ? new Date(earliestDate).toISOString() : null;

  const result = {
    version: 1,
    lastComputedDate: new Date().toISOString().slice(0, 10),
    dailyActivity: dailyActivityArr,
    dailyModelTokens: dailyModelTokensArr,
    modelUsage,
    totalSessions: sessions.size,
    totalMessages: dailyActivityArr.reduce((s, d) => s + d.messageCount, 0),
    totalCostUSD: totalCost,
    longestSession,
    firstSessionDate,
    hourCounts,
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(result), 'utf-8');

  console.log(`Stats rebuilt: ${sessions.size} sessions, ${result.totalMessages} messages, ${sortedDates.length} days`);
  console.log(`Models: ${Object.keys(modelUsage).join(', ')}`);
  console.log(`Estimated total cost: $${totalCost.toFixed(2)}`);
  console.log(`Saved to ${OUTPUT_FILE}`);
}

scanSessions().catch(console.error);
