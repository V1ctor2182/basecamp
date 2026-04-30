import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import { z } from 'zod';
import yaml from 'js-yaml';
import { markdownToTemplateHtml, ALLOWED_TAGS } from './src/career/lib/markdownToTemplateHtml.mjs';
import { htmlToPdf, shutdownBrowser } from './src/career/lib/htmlToPdf.mjs';
import { composeCvHtml } from './src/career/lib/cvTemplate.mjs';
import {
  startScan,
  getScanStatus,
  ScanAlreadyRunningError,
  PIPELINE_FILE,
} from './src/career/finder/scanRunner.mjs';
import {
  readPortalsConfig,
  writePortalsConfig,
} from './src/career/finder/portalsLoader.mjs';
import { manualPaste } from './src/career/finder/adapters/manual.mjs';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const app = express();
app.use(cors());
// Default 10MB for tracker/learn endpoints; career endpoints get a stricter cap
// applied per-route below (256KB — config-shaped data, not bulk payloads).
app.use((req, res, next) => {
  if (req.path.startsWith('/api/career/')) {
    return express.json({ limit: '256kb' })(req, res, next);
  }
  return express.json({ limit: '10mb' })(req, res, next);
});

// Data files
const DATA_DIR = path.join(__dirname, 'data');
const REPOS_FILE = path.join(DATA_DIR, 'repos.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const COMMIT_STATS_FILE = path.join(DATA_DIR, 'commit-stats.json');
const PR_STATS_FILE = path.join(DATA_DIR, 'pr-stats.json');

// Career system data
const CAREER_DIR = path.join(DATA_DIR, 'career');
const LLM_COSTS_FILE = path.join(CAREER_DIR, 'llm-costs.jsonl');
const IDENTITY_FILE = path.join(CAREER_DIR, 'identity.yml');
const PREFERENCES_FILE = path.join(CAREER_DIR, 'preferences.yml');
const NARRATIVE_FILE = path.join(CAREER_DIR, 'narrative.md');
const PROOF_POINTS_FILE = path.join(CAREER_DIR, 'proof-points.md');
const QA_BANK_DIR = path.join(CAREER_DIR, 'qa-bank');
const QA_LEGAL_FILE = path.join(QA_BANK_DIR, 'legal.yml');
const QA_TEMPLATES_FILE = path.join(QA_BANK_DIR, 'templates.md');
const QA_HISTORY_FILE = path.join(QA_BANK_DIR, 'history.jsonl');
const RESUMES_DIR = path.join(CAREER_DIR, 'resumes');
const RESUMES_INDEX_FILE = path.join(RESUMES_DIR, 'index.yml');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(REPOS_FILE)) writeFileSync(REPOS_FILE, '[]');
if (!existsSync(CONFIG_FILE)) writeFileSync(CONFIG_FILE, '{}');
if (!existsSync(COMMIT_STATS_FILE)) writeFileSync(COMMIT_STATS_FILE, '{}');
if (!existsSync(PR_STATS_FILE)) writeFileSync(PR_STATS_FILE, '{}');
if (!existsSync(CAREER_DIR)) mkdirSync(CAREER_DIR, { recursive: true });
if (!existsSync(LLM_COSTS_FILE)) writeFileSync(LLM_COSTS_FILE, '');
if (!existsSync(QA_BANK_DIR)) mkdirSync(QA_BANK_DIR, { recursive: true });
if (!existsSync(RESUMES_DIR)) mkdirSync(RESUMES_DIR, { recursive: true });
if (!existsSync(QA_HISTORY_FILE)) writeFileSync(QA_HISTORY_FILE, '');

// Helpers
async function readJSON(file) { return JSON.parse(await fs.readFile(file, 'utf-8')); }

// Atomic write: tempfile + rename. POSIX-atomic on same filesystem so a crash
// mid-write leaves the original file intact rather than half-written garbage
// that fails to parse on next boot.
async function atomicWriteFile(file, content) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, file);
  } catch (e) {
    fs.unlink(tmp).catch(() => {}); // tmp may not exist if writeFile failed early
    throw e;
  }
}
async function writeJSON(file, data) { await atomicWriteFile(file, JSON.stringify(data, null, 2)); }

// Deep-merge: defaults provide structure for any keys missing in `loaded`.
// Plain-object values are merged recursively; arrays and primitives in `loaded`
// replace defaults wholesale (so an explicit empty array from yaml stays empty).
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
function deepMerge(defaults, loaded) {
  if (!isPlainObject(loaded)) return loaded === undefined ? defaults : loaded;
  if (!isPlainObject(defaults)) return loaded;
  const out = { ...defaults };
  for (const k of Object.keys(loaded)) {
    out[k] = isPlainObject(defaults[k]) && isPlainObject(loaded[k])
      ? deepMerge(defaults[k], loaded[k])
      : loaded[k];
  }
  return out;
}

// In-memory write-through caches for stats (persist across requests without re-reading file)
let _commitStats = null;
let _prStats = null;

async function getCommitStats() {
  if (!_commitStats) _commitStats = await readJSON(COMMIT_STATS_FILE).catch(() => ({}));
  return _commitStats;
}

async function getPRStats() {
  if (!_prStats) _prStats = await readJSON(PR_STATS_FILE).catch(() => ({}));
  return _prStats;
}

// Concurrency-limited map: runs fn on each item with at most `limit` in parallel
async function pLimit(items, fn, limit = 5) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i]); } catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseGitHubUrl(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/\s?#]+)/);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null;
}

// Persistent disk-backed cache with 1-hour TTL
const CACHE_FILE = path.join(DATA_DIR, 'github-cache.json');
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
let cache = new Map();

// Load cache from disk on startup
try {
  if (existsSync(CACHE_FILE)) {
    const entries = JSON.parse(await fs.readFile(CACHE_FILE, 'utf-8'));
    const now = Date.now();
    for (const [key, val] of entries) {
      if (now - val.time < CACHE_TTL) cache.set(key, val);
    }
  }
} catch { /* start fresh */ }

let cacheWritePending = false;
function scheduleCacheWrite() {
  if (cacheWritePending) return;
  cacheWritePending = true;
  setTimeout(async () => {
    cacheWritePending = false;
    try { await fs.writeFile(CACHE_FILE, JSON.stringify([...cache])); } catch { /* ignore */ }
  }, 2000);
}

// Sweep expired cache entries every 30 min
setInterval(() => {
  const now = Date.now();
  let swept = false;
  for (const [key, val] of cache) {
    if (now - val.time >= CACHE_TTL) { cache.delete(key); swept = true; }
  }
  if (swept) scheduleCacheWrite();
}, 30 * 60 * 1000);

// Cap persistent stats caches to prevent unbounded file growth
const MAX_STATS_ENTRIES = 10000;
function trimStatsCache(obj) {
  const keys = Object.keys(obj);
  if (keys.length <= MAX_STATS_ENTRIES) return obj;
  const keep = keys.slice(-Math.floor(MAX_STATS_ENTRIES / 2));
  const trimmed = {};
  for (const k of keep) trimmed[k] = obj[k];
  return trimmed;
}

async function githubFetch(endpoint) {
  const cached = cache.get(endpoint);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;
  if (cached) cache.delete(endpoint); // evict expired entry

  const config = await readJSON(CONFIG_FILE);
  const token = process.env.GITHUB_TOKEN || config.githubToken;
  const headers = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'work-tracker' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res = await fetch(`https://api.github.com${endpoint}`, { headers });

  // Retry once on secondary rate limit (403 with Retry-After)
  if (res.status === 403 || res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
    const wait = Math.min(retryAfter, 60) * 1000;
    await new Promise(r => setTimeout(r, wait));
    res = await fetch(`https://api.github.com${endpoint}`, { headers });
  }

  if (res.status === 409) return []; // empty repo
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  cache.set(endpoint, { data, time: Date.now() });
  scheduleCacheWrite();
  return data;
}

// --- Config ---
app.get('/api/config', async (_req, res) => {
  try {
    const config = await readJSON(CONFIG_FILE);
    const envToken = process.env.GITHUB_TOKEN;
    res.json({
      githubUsername: config.githubUsername || '',
      hasToken: !!(envToken || config.githubToken),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/config', async (req, res) => {
  try {
    const existing = await readJSON(CONFIG_FILE);
    const { githubUsername, githubToken } = req.body;
    if (githubUsername !== undefined) existing.githubUsername = githubUsername;
    if (githubToken) existing.githubToken = githubToken;
    await writeJSON(CONFIG_FILE, existing);
    cache.clear();
    scheduleCacheWrite();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Repos ---
app.get('/api/repos', async (_req, res) => {
  try { res.json(await readJSON(REPOS_FILE)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/repos', async (req, res) => {
  try {
    const parsed = parseGitHubUrl(req.body.url);
    if (!parsed) return res.status(400).json({ error: 'Invalid GitHub URL' });

    const repos = await readJSON(REPOS_FILE);
    const id = `${parsed.owner}/${parsed.repo}`;
    if (repos.find(r => r.id === id)) return res.status(409).json({ error: 'Repo already tracked' });

    const newRepo = { id, url: `https://github.com/${id}`, ...parsed, addedAt: new Date().toISOString() };
    repos.push(newRepo);
    await writeJSON(REPOS_FILE, repos);
    res.json(newRepo);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Sync repos from recent commits (last 3 days) ---
app.post('/api/repos/sync', async (req, res) => {
  try {
    const config = await readJSON(CONFIG_FILE);
    const username = config.githubUsername;
    if (!username) return res.status(400).json({ error: 'Set GitHub username in settings first' });

    const since = new Date();
    since.setDate(since.getDate() - 3);
    const sinceStr = since.toISOString().slice(0, 10);
    const q = encodeURIComponent(`author:${username} committer-date:>=${sinceStr}`);

    // 1. Search public commits (max 2 pages = 200 results)
    const repoMap = new Map();
    for (let page = 1; page <= 2; page++) {
      const data = await githubFetch(`/search/commits?q=${q}&per_page=100&page=${page}&sort=committer-date`);
      if (!data.items || data.items.length === 0) break;
      for (const item of data.items) {
        const repo = item.repository;
        if (repo && !repoMap.has(repo.full_name)) {
          repoMap.set(repo.full_name, repo);
        }
      }
      if (data.items.length < 100) break;
    }

    // 2. Private repos (1 extra request)
    const privateRepos = await githubFetch('/user/repos?per_page=100&visibility=private&sort=pushed').catch(() => []);
    if (Array.isArray(privateRepos)) {
      const threeDaysAgo = since.toISOString();
      for (const gh of privateRepos) {
        if (gh.pushed_at && gh.pushed_at >= threeDaysAgo && !repoMap.has(gh.full_name)) {
          repoMap.set(gh.full_name, gh);
        }
      }
    }

    const repos = await readJSON(REPOS_FILE);
    const existingIds = new Set(repos.map(r => r.id));
    let added = 0;

    for (const [id, gh] of repoMap) {
      if (existingIds.has(id)) continue;
      repos.push({
        id,
        url: gh.html_url,
        owner: gh.owner.login,
        repo: gh.name,
        addedAt: new Date().toISOString(),
      });
      added++;
    }

    await writeJSON(REPOS_FILE, repos);
    res.json({ ok: true, added, total: repos.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/repos/:owner/:repo', async (req, res) => {
  try {
    const id = `${req.params.owner}/${req.params.repo}`;
    const repos = (await readJSON(REPOS_FILE)).filter(r => r.id !== id);
    await writeJSON(REPOS_FILE, repos);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Activity (all branches) ---
app.get('/api/activity', async (req, res) => {
  try {
    const { since, until, author } = req.query;
    const repos = await readJSON(REPOS_FILE);
    if (repos.length === 0) return res.json({ activity: [], errors: [] });

    const results = await Promise.allSettled(
      repos.map(async (repo) => {
        // Fetch all branches, then commits per branch, dedupe by sha
        const branches = await githubFetch(`/repos/${repo.id}/branches?per_page=100`).catch(() => []);
        const branchList = Array.isArray(branches) ? branches : [];

        const commitsBySha = new Map(); // sha -> { commit, branches: Set }
        await pLimit(branchList, async (br) => {
          let endpoint = `/repos/${repo.id}/commits?per_page=100&sha=${encodeURIComponent(br.name)}`;
          if (since) endpoint += `&since=${since}`;
          if (until) endpoint += `&until=${until}`;
          if (author) endpoint += `&author=${author}`;
          const commits = await githubFetch(endpoint).catch(() => []);
          for (const c of (Array.isArray(commits) ? commits : [])) {
            if (!commitsBySha.has(c.sha)) commitsBySha.set(c.sha, { commit: c, branches: new Set() });
            commitsBySha.get(c.sha).branches.add(br.name);
          }
        }, 5);

        return {
          repo: repo.id,
          repoUrl: repo.url,
          branches: branchList.map(b => b.name),
          commits: [...commitsBySha.values()].map(({ commit: c, branches: brs }) => ({
            sha: c.sha,
            message: c.commit.message,
            author: c.commit.author.name,
            date: c.commit.committer.date,
            url: c.html_url,
            branch: [...brs].join(', '),
          })),
        };
      })
    );

    const activity = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') activity.push(r.value);
      else errors.push({ repo: repos[i].id, error: r.reason?.message || 'Unknown error' });
    });

    // Enrich commits with line stats (from local cache; fetch uncached ones, cap at 50 per request)
    const commitStats = await getCommitStats();
    const toFetch = [];
    for (const ra of activity) {
      for (const c of ra.commits) {
        if (!commitStats[c.sha]) {
          toFetch.push({ repoId: ra.repo, sha: c.sha });
          if (toFetch.length >= 50) break;
        }
      }
      if (toFetch.length >= 50) break;
    }
    if (toFetch.length > 0) {
      await pLimit(toFetch, async ({ repoId, sha }) => {
        const data = await githubFetch(`/repos/${repoId}/commits/${sha}`).catch(() => null);
        if (data?.stats) commitStats[sha] = { additions: data.stats.additions, deletions: data.stats.deletions };
      }, 5);
      _commitStats = trimStatsCache(commitStats);
      writeJSON(COMMIT_STATS_FILE, _commitStats).catch(e => console.warn('stats cache write failed:', e.message));
    }
    for (const ra of activity) {
      for (const c of ra.commits) {
        const s = commitStats[c.sha];
        if (s) { c.additions = s.additions; c.deletions = s.deletions; }
      }
    }

    res.json({ activity, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Pull Requests ---
app.get('/api/prs', async (req, res) => {
  try {
    const { since, author } = req.query;
    const repos = await readJSON(REPOS_FILE);
    if (repos.length === 0) return res.json({ prs: [], errors: [] });

    const results = await Promise.allSettled(
      repos.map(async (repo) => {
        // Fetch open + recently closed PRs
        const [openPRs, closedPRs] = await Promise.all([
          githubFetch(`/repos/${repo.id}/pulls?state=open&per_page=50&sort=updated&direction=desc`),
          githubFetch(`/repos/${repo.id}/pulls?state=closed&per_page=50&sort=updated&direction=desc`),
        ]);

        const all = [...(Array.isArray(openPRs) ? openPRs : []), ...(Array.isArray(closedPRs) ? closedPRs : [])];

        let filtered = all;
        if (author) {
          const a = author.toLowerCase();
          filtered = filtered.filter(pr => pr.user?.login?.toLowerCase() === a);
        }
        if (since) {
          const sinceDate = new Date(since);
          filtered = filtered.filter(pr => new Date(pr.updated_at) >= sinceDate);
        }

        return {
          repo: repo.id,
          repoUrl: repo.url,
          prs: filtered.map(pr => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            merged: !!pr.merged_at,
            author: pr.user?.login || '',
            branch: pr.head?.ref || '',
            baseBranch: pr.base?.ref || '',
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            mergedAt: pr.merged_at,
            closedAt: pr.closed_at,
            url: pr.html_url,
            reviewComments: pr.review_comments,
          })),
        };
      })
    );

    const prs = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') prs.push(r.value);
      else errors.push({ repo: repos[i].id, error: r.reason?.message || 'Unknown error' });
    });

    // Enrich PRs with line stats from local cache; fetch uncached ones
    const prStats = await getPRStats();
    const prToFetch = [];
    for (const rp of prs) {
      for (const pr of rp.prs) {
        const key = `${rp.repo}#${pr.number}`;
        if (!prStats[key]) {
          prToFetch.push({ repoId: rp.repo, number: pr.number, key });
          if (prToFetch.length >= 50) break;
        }
      }
      if (prToFetch.length >= 50) break;
    }
    if (prToFetch.length > 0) {
      await pLimit(prToFetch, async ({ repoId, number, key }) => {
        const data = await githubFetch(`/repos/${repoId}/pulls/${number}`).catch(() => null);
        if (data?.additions != null) prStats[key] = { additions: data.additions, deletions: data.deletions };
      }, 5);
      _prStats = trimStatsCache(prStats);
      writeJSON(PR_STATS_FILE, _prStats).catch(e => console.warn('stats cache write failed:', e.message));
    }
    for (const rp of prs) {
      for (const pr of rp.prs) {
        const s = prStats[`${rp.repo}#${pr.number}`];
        if (s) { pr.additions = s.additions; pr.deletions = s.deletions; }
      }
    }

    res.json({ prs, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Rate limit ---
app.get('/api/rate-limit', async (_req, res) => {
  try {
    const data = await githubFetch('/rate_limit');
    res.json(data.rate || data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================
// Learn Knowledge Base — Multi-directory support
// =====================
const LEARN_DIRS_FILE = path.join(DATA_DIR, 'learn-dirs.json');

// Initialize learn-dirs.json as empty if missing — users add their own directories via the UI
if (!existsSync(LEARN_DIRS_FILE)) {
  writeFileSync(LEARN_DIRS_FILE, '[]');
}

async function getLearnDirs() {
  const dirs = await readJSON(LEARN_DIRS_FILE);
  return dirs.filter(d => existsSync(d.path));
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Resolve a prefixed path like "learn/subfolder/file.md" → { dirPath, relativePath }
async function resolvePath(prefixedPath) {
  const dirs = await getLearnDirs();
  const firstSlash = prefixedPath.indexOf('/');
  const dirId = firstSlash === -1 ? prefixedPath : prefixedPath.slice(0, firstSlash);
  const rel = firstSlash === -1 ? '' : prefixedPath.slice(firstSlash + 1);
  const dir = dirs.find(d => d.id === dirId);
  if (!dir) throw new Error(`Unknown directory: ${dirId}`);
  const fullPath = rel ? path.join(dir.path, rel) : dir.path;
  if (fullPath !== dir.path && !fullPath.startsWith(dir.path + '/')) throw new Error('Path traversal');
  return { dir, fullPath, rel, dirId };
}

async function buildTree(dirPath, relativePath, ignoreList = []) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const children = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || ignoreList.includes(entry.name)) continue;
    const rel = relativePath ? path.join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const sub = await buildTree(path.join(dirPath, entry.name), rel);
      children.push({ name: entry.name, path: rel, type: 'dir', children: sub });
    } else if (entry.name.endsWith('.md')) {
      children.push({ name: entry.name, path: rel, type: 'file' });
    }
  }
  return children;
}

// --- Folder Picker (native macOS dialog) ---
app.post('/api/pick-folder', async (_req, res) => {
  try {
    const { exec } = await import('child_process');
    const script = `osascript -e 'POSIX path of (choose folder with prompt "Choose a folder to add")'`;
    exec(script, { encoding: 'utf-8', timeout: 120000 }, (err, stdout) => {
      if (err) {
        // User cancelled or error — status 1 means cancel
        return res.json({ cancelled: true });
      }
      const result = stdout.trim();
      const folder = result.endsWith('/') ? result.slice(0, -1) : result;
      res.json({ path: folder, name: path.basename(folder) });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Learn Dirs CRUD ---
app.get('/api/learn-dirs', async (_req, res) => {
  try { res.json(await getLearnDirs()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/learn-dirs', async (req, res) => {
  try {
    const { name, path: dirPath } = req.body;
    if (!name || !dirPath) return res.status(400).json({ error: 'name and path required' });
    const resolved = path.resolve(dirPath.replace(/^~/, os.homedir()));
    if (!existsSync(resolved)) return res.status(400).json({ error: 'Directory does not exist' });
    const dirs = await readJSON(LEARN_DIRS_FILE);
    const id = slugify(name);
    if (dirs.find(d => d.id === id)) return res.status(409).json({ error: 'A directory with this name already exists' });
    if (dirs.find(d => d.path === resolved)) return res.status(409).json({ error: 'This directory is already added' });
    dirs.push({ id, name, path: resolved });
    await writeJSON(LEARN_DIRS_FILE, dirs);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/learn-dirs/:id', async (req, res) => {
  try {
    const dirs = (await readJSON(LEARN_DIRS_FILE)).filter(d => d.id !== req.params.id);
    await writeJSON(LEARN_DIRS_FILE, dirs);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Prefix children paths with dirId recursively
function prefixPaths(nodes, dirId) {
  return nodes.map(n => ({
    ...n,
    path: `${dirId}/${n.path}`,
    children: n.children ? prefixPaths(n.children, dirId) : undefined,
  }));
}

// --- Tree (merged from all dirs) ---
app.get('/api/tree', async (_req, res) => {
  try {
    const dirs = await getLearnDirs();
    const roots = [];
    for (const d of dirs) {
      const children = await buildTree(d.path, '', []);
      roots.push({ name: d.name, path: d.id, type: 'dir', children: prefixPaths(children, d.id), _isRoot: true });
    }
    // If only one dir, return its children directly for cleaner UX
    if (roots.length === 1) return res.json(roots[0].children);
    res.json(roots);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/file', async (req, res) => {
  try {
    const { fullPath } = await resolvePath(req.query.path);
    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/file', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    const { fullPath } = await resolvePath(filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/new', async (req, res) => {
  try {
    const { dir, name, dirId } = req.body;
    const dirs = await getLearnDirs();
    // Use specified dirId, or first dir as default
    const targetDir = dirs.find(d => d.id === dirId) || dirs[0];
    if (!targetDir) return res.status(400).json({ error: 'No directories configured' });
    const fileName = name.endsWith('.md') ? name : name + '.md';
    const fullPath = path.join(targetDir.path, dir || '', fileName);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, `# ${name.replace('.md', '')}\n\n`, 'utf-8');
    const rel = path.relative(targetDir.path, fullPath);
    res.json({ path: `${targetDir.id}/${rel}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folder', async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    const { fullPath } = await resolvePath(dirPath);
    await fs.mkdir(fullPath, { recursive: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rename', async (req, res) => {
  try {
    const { path: itemPath, newName } = req.body;
    const { dir, fullPath, dirId } = await resolvePath(itemPath);
    const newFullPath = path.join(path.dirname(fullPath), newName);
    if (!newFullPath.startsWith(dir.path)) return res.status(400).json({ error: 'Invalid path' });
    try { await fs.access(newFullPath); return res.status(409).json({ error: 'Name already exists' }); } catch {}
    await fs.rename(fullPath, newFullPath);
    if (fullPath.endsWith('.md')) {
      const tsxOld = fullPath.replace(/\.md$/, '.tsx');
      const tsxNew = newFullPath.replace(/\.md$/, '.tsx');
      try { await fs.access(tsxOld); await fs.rename(tsxOld, tsxNew); } catch {}
    }
    res.json({ ok: true, newPath: `${dirId}/${path.relative(dir.path, newFullPath)}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/delete', async (req, res) => {
  try {
    const { path: itemPath } = req.body;
    const { dir, fullPath } = await resolvePath(itemPath);
    if (fullPath === dir.path) return res.status(400).json({ error: 'Cannot delete root' });
    await fs.rm(fullPath, { recursive: true });
    if (fullPath.endsWith('.md')) {
      const tsxPath = fullPath.replace(/\.md$/, '.tsx');
      try { await fs.rm(tsxPath); } catch {}
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload', async (req, res) => {
  try {
    const { files, dirId } = req.body;
    if (!files || !Array.isArray(files)) return res.status(400).json({ error: 'Missing files array' });

    const dirs = await getLearnDirs();
    const targetDir = dirs.find(d => d.id === dirId) || dirs[0];
    if (!targetDir) return res.status(400).json({ error: 'No directories configured' });

    const results = [];
    for (const file of files) {
      const fileName = file.name.endsWith('.md') ? file.name : file.name + '.md';
      const filePath = file.dir ? path.join(file.dir, fileName) : fileName;
      const fullPath = path.join(targetDir.path, filePath);

      try {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, file.content, 'utf-8');
        results.push({ path: `${targetDir.id}/${filePath}`, ok: true });
      } catch (err) {
        results.push({ path: filePath, ok: false, error: err.message });
      }
    }

    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/move', async (req, res) => {
  try {
    const { from, to } = req.body;
    const fromResolved = await resolvePath(from);
    const toResolved = await resolvePath(to);
    const name = path.basename(fromResolved.fullPath);
    const fullTo = path.join(toResolved.fullPath, name);
    if (!fullTo.startsWith(toResolved.dir.path)) return res.status(400).json({ error: 'Invalid path' });
    await fs.mkdir(toResolved.fullPath, { recursive: true });
    await fs.rename(fromResolved.fullPath, fullTo);
    if (fromResolved.fullPath.endsWith('.md')) {
      const tsxFrom = fromResolved.fullPath.replace(/\.md$/, '.tsx');
      const tsxTo = fullTo.replace(/\.md$/, '.tsx');
      try { await fs.access(tsxFrom); await fs.rename(tsxFrom, tsxTo); } catch {}
    }
    res.json({ ok: true, newPath: `${toResolved.dirId}/${path.relative(toResolved.dir.path, fullTo)}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Claude Usage Stats ---
const CLAUDE_STATS_FILE = path.join(DATA_DIR, 'claude-stats.json');
const DAILY_COST_FILE = path.join(DATA_DIR, 'daily-cost.json');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
let statsRebuilding = false;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function collectJsonlFiles(dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...await collectJsonlFiles(full));
    else if (entry.name.endsWith('.jsonl')) results.push(full);
  }
  return results;
}

// Scan a single JSONL file and return its contribution to activity stats.
async function scanJsonlFile(filePath, projDir) {
  const sessionId = path.basename(filePath, '.jsonl');
  const contrib = {
    sessions: [],        // session IDs seen
    cwd: null,
    daily: {},           // date -> { messages, toolCalls, sessions: [ids] }
    hourCounts: {},      // hour -> count
    sessionMeta: {},     // sessionId -> { start, end, messageCount }
  };
  try {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!contrib.cwd && typeof record.cwd === 'string' && record.cwd) {
        contrib.cwd = record.cwd;
      }
      const ts = record.timestamp;
      if (!ts) continue;
      const localDate = new Date(ts);
      const date = `${localDate.getFullYear()}-${String(localDate.getMonth()+1).padStart(2,'0')}-${String(localDate.getDate()).padStart(2,'0')}`;
      const hour = localDate.getHours();

      if (record.type === 'user' && record.userType === 'external') {
        if (!contrib.sessions.includes(sessionId)) contrib.sessions.push(sessionId);
        if (!contrib.daily[date]) contrib.daily[date] = { messages: 0, toolCalls: 0, sessions: [] };
        if (!contrib.daily[date].sessions.includes(sessionId)) contrib.daily[date].sessions.push(sessionId);
        if (!contrib.sessionMeta[sessionId]) contrib.sessionMeta[sessionId] = { start: ts, end: ts, messageCount: 0 };
        contrib.sessionMeta[sessionId].messageCount++;
        if (ts > contrib.sessionMeta[sessionId].end) contrib.sessionMeta[sessionId].end = ts;
        if (ts < contrib.sessionMeta[sessionId].start) contrib.sessionMeta[sessionId].start = ts;
      }

      if (record.type === 'assistant') {
        if (!contrib.daily[date]) contrib.daily[date] = { messages: 0, toolCalls: 0, sessions: [] };
        contrib.daily[date].messages++;
        contrib.hourCounts[hour] = (contrib.hourCounts[hour] || 0) + 1;
        const msg = record.message || {};
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_use') contrib.daily[date].toolCalls++;
          }
        }
      }
    }
  } catch { /* skip unreadable */ }
  return contrib;
}

// Recompute activity totals by summing all per-file contributions.
function aggregateContributions(fileContribs) {
  const dailyActivity = {};  // date -> { messages, sessions: Set, toolCalls }
  const hourCounts = {};
  const sessions = new Set();
  const sessionMeta = {};
  const projectCwd = {};     // projDir -> cwd
  let firstDate = null;

  for (const [filePath, contrib] of Object.entries(fileContribs)) {
    // Extract projDir from file path: .../projects/{projDir}/...
    const projMatch = filePath.match(/projects\/([^/]+)\//);
    const projDir = projMatch ? projMatch[1] : null;
    if (projDir && contrib.cwd && !projectCwd[projDir]) {
      projectCwd[projDir] = contrib.cwd;
    }

    for (const sid of (contrib.sessions || [])) sessions.add(sid);

    for (const [date, day] of Object.entries(contrib.daily || {})) {
      if (!dailyActivity[date]) dailyActivity[date] = { messages: 0, sessions: new Set(), toolCalls: 0 };
      dailyActivity[date].messages += day.messages;
      dailyActivity[date].toolCalls += day.toolCalls;
      for (const sid of (day.sessions || [])) dailyActivity[date].sessions.add(sid);
      if (!firstDate || date < firstDate) firstDate = date;
    }

    for (const [h, count] of Object.entries(contrib.hourCounts || {})) {
      hourCounts[h] = (hourCounts[h] || 0) + count;
    }

    for (const [sid, meta] of Object.entries(contrib.sessionMeta || {})) {
      if (!sessionMeta[sid]) {
        sessionMeta[sid] = { ...meta };
      } else {
        sessionMeta[sid].messageCount += meta.messageCount;
        if (meta.start < sessionMeta[sid].start) sessionMeta[sid].start = meta.start;
        if (meta.end > sessionMeta[sid].end) sessionMeta[sid].end = meta.end;
      }
    }
  }

  return { dailyActivity, hourCounts, sessions, sessionMeta, projectCwd, firstDate };
}

async function updateStats() {
  if (statsRebuilding) return;
  statsRebuilding = true;
  try {
    // Load existing stats (includes _fileContribs and _processedFiles for incremental scan)
    let oldStats = null;
    try {
      const raw = await fs.readFile(CLAUDE_STATS_FILE, 'utf-8');
      oldStats = JSON.parse(raw);
    } catch { /* no existing stats, fresh build */ }

    const fileContribs = { ...(oldStats?._fileContribs || {}) };
    const processedFiles = { ...(oldStats?._processedFiles || {}) };
    let scanned = 0, skipped = 0;

    // Incremental scan: only read new/changed JSONL files
    const projectDirs = await fs.readdir(CLAUDE_PROJECTS_DIR).catch(() => []);
    for (const projDir of projectDirs) {
      const projPath = path.join(CLAUDE_PROJECTS_DIR, projDir);
      const stat = await fs.stat(projPath).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const files = await collectJsonlFiles(projPath);

      for (const filePath of files) {
        let fstat;
        try { fstat = await fs.stat(filePath); } catch { continue; }
        const prev = processedFiles[filePath];
        if (prev && prev.size === fstat.size && prev.mtime === fstat.mtimeMs) {
          skipped++;
          continue;
        }
        // New or changed file — (re)scan and replace its contribution
        fileContribs[filePath] = await scanJsonlFile(filePath, projDir);
        processedFiles[filePath] = { size: fstat.size, mtime: fstat.mtimeMs };
        scanned++;
      }
    }

    // Recompute activity totals from all per-file contributions
    const { dailyActivity, hourCounts, sessions, sessionMeta, projectCwd, firstDate } = aggregateContributions(fileContribs);

    const sortedDates = Object.keys(dailyActivity).sort();
    const newDailyActivityArr = sortedDates.map(date => ({
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

    // Pull token + cost data from ccusage (live LiteLLM pricing).
    // ccusage does its own full scan — this will be replaced later.
    let newDailyModelTokensArr = [];
    let newDailyCostArr = [];
    let newModelUsage = {};
    let newTotalCost = 0;
    let newProjectUsage = {};
    try {
      const ccusageBin = path.join(__dirname, 'node_modules', '.bin', 'ccusage');
      const ccusageCmd = existsSync(ccusageBin) ? ccusageBin : 'npx ccusage';
      const out = execSync(`${ccusageCmd} daily --instances --json`, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
      const ccusageJson = JSON.parse(out);

      const tokensByDate = {};
      const costByDate = {};

      for (const [encodedDir, entries] of Object.entries(ccusageJson.projects || {})) {
        let projTotalCost = 0;
        const projModels = {};
        const projDailyMap = {};
        const projDates = new Set();
        let projFirstDate = null;
        let projLastDate = null;

        for (const entry of entries) {
          const date = entry.date;
          projDates.add(date);
          if (!projFirstDate || date < projFirstDate) projFirstDate = date;
          if (!projLastDate || date > projLastDate) projLastDate = date;
          if (!projDailyMap[date]) projDailyMap[date] = { date, totalCostUSD: 0, models: {} };
          const dayBucket = projDailyMap[date];

          for (const m of entry.modelBreakdowns) {
            if (!projModels[m.modelName]) projModels[m.modelName] = { outputTokens: 0, costUSD: 0 };
            projModels[m.modelName].outputTokens += m.outputTokens;
            projModels[m.modelName].costUSD += m.cost;
            projTotalCost += m.cost;
            if (!dayBucket.models[m.modelName]) dayBucket.models[m.modelName] = { outputTokens: 0, costUSD: 0 };
            dayBucket.models[m.modelName].outputTokens += m.outputTokens;
            dayBucket.models[m.modelName].costUSD += m.cost;
            dayBucket.totalCostUSD += m.cost;
            if (!tokensByDate[date]) tokensByDate[date] = {};
            tokensByDate[date][m.modelName] = (tokensByDate[date][m.modelName] || 0)
              + m.inputTokens + m.outputTokens;
            if (!costByDate[date]) costByDate[date] = {};
            costByDate[date][m.modelName] = (costByDate[date][m.modelName] || 0) + m.cost;
            if (!newModelUsage[m.modelName]) {
              newModelUsage[m.modelName] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
            }
            const u = newModelUsage[m.modelName];
            u.inputTokens += m.inputTokens;
            u.outputTokens += m.outputTokens;
            u.cacheReadInputTokens += m.cacheReadTokens;
            u.cacheCreationInputTokens += m.cacheCreationTokens;
            u.costUSD += m.cost;
          }
        }

        newTotalCost += projTotalCost;
        if (projTotalCost >= 10) {
          const cwd = projectCwd[encodedDir];
          const displayName = cwd ? path.basename(cwd) : encodedDir;
          const dailyBreakdown = Object.values(projDailyMap)
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, 10);
          newProjectUsage[encodedDir] = {
            displayName, cwd: cwd || null, totalCostUSD: projTotalCost,
            daysActive: projDates.size, firstActivity: projFirstDate, lastActivity: projLastDate,
            models: projModels, dailyBreakdown,
          };
        }
      }

      newDailyModelTokensArr = Object.keys(tokensByDate).sort().map(date => ({ date, tokensByModel: tokensByDate[date] }));
      newDailyCostArr = Object.keys(costByDate).sort().map(date => ({ date, costByModel: costByDate[date] }));
    } catch (e) {
      console.error('ccusage failed — token/cost data omitted.', e.message);
    }

    // For token/cost: merge with old stats to preserve data from deleted JSONL files
    // (ccusage also reads JSONL, so it loses old data too)
    const mergedDailyModelTokens = mergeDailyByDate(oldStats?.dailyModelTokens, newDailyModelTokensArr);
    const mergedDailyCost = mergeDailyByDate(oldStats?.dailyCost, newDailyCostArr);
    const mergedModelUsage = {};
    const allModels = new Set([...Object.keys(oldStats?.modelUsage || {}), ...Object.keys(newModelUsage)]);
    for (const model of allModels) {
      const o = (oldStats?.modelUsage || {})[model] || {};
      const n = newModelUsage[model] || {};
      mergedModelUsage[model] = {
        inputTokens: Math.max(o.inputTokens || 0, n.inputTokens || 0),
        outputTokens: Math.max(o.outputTokens || 0, n.outputTokens || 0),
        cacheReadInputTokens: Math.max(o.cacheReadInputTokens || 0, n.cacheReadInputTokens || 0),
        cacheCreationInputTokens: Math.max(o.cacheCreationInputTokens || 0, n.cacheCreationInputTokens || 0),
        costUSD: Math.max(o.costUSD || 0, n.costUSD || 0),
      };
    }
    const mergedProjectUsage = { ...(oldStats?.projectUsage || {}), ...newProjectUsage };
    const mergedTotalCost = mergedDailyCost.reduce((s, d) => Object.values(d.costByModel || {}).reduce((a, b) => a + b, 0) + s, 0);

    const earliestDate = firstDate || oldStats?.firstSessionDate || (sortedDates.length > 0 ? sortedDates[0] : null);

    const result = {
      version: 7, lastComputedDate: todayStr(),
      dailyActivity: newDailyActivityArr, dailyModelTokens: mergedDailyModelTokens, dailyCost: mergedDailyCost,
      modelUsage: mergedModelUsage, projectUsage: mergedProjectUsage,
      totalSessions: sessions.size,
      totalMessages: newDailyActivityArr.reduce((s, d) => s + d.messageCount, 0),
      totalCostUSD: mergedTotalCost, longestSession,
      firstSessionDate: earliestDate,
      hourCounts, totalSpeculationTimeSavedMs: 0, shotDistribution: {},
      _fileContribs: fileContribs,
      _processedFiles: processedFiles,
    };

    await fs.writeFile(CLAUDE_STATS_FILE, JSON.stringify(result), 'utf-8');
    console.log(`Stats updated: ${sessions.size} sessions, ${result.totalMessages} msgs (scanned ${scanned}, skipped ${skipped})`);
  } catch (e) {
    console.error('Stats update failed:', e.message);
  } finally {
    statsRebuilding = false;
  }
}

// Merge daily arrays by date: new scan wins for dates it has, old dates preserved
function mergeDailyByDate(oldArr, newArr, dateKey = 'date') {
  const map = new Map();
  for (const entry of (oldArr || [])) map.set(entry[dateKey], entry);
  for (const entry of (newArr || [])) map.set(entry[dateKey], entry);
  return [...map.values()].sort((a, b) => a[dateKey].localeCompare(b[dateKey]));
}

// Rebuild on server start
updateStats();

const STATS_SCHEMA_VERSION = 7;

app.get('/api/claude-stats', async (_req, res) => {
  try {
    // Trigger async rebuild if stale (date) or schema mismatch
    try {
      const raw = await fs.readFile(CLAUDE_STATS_FILE, 'utf-8');
      const stats = JSON.parse(raw);
      const schemaStale = (stats.version ?? 0) < STATS_SCHEMA_VERSION;
      if (schemaStale) {
        // Schema mismatch: force synchronous rebuild so the client gets fresh data immediately
        await updateStats();
        const fresh = JSON.parse(await fs.readFile(CLAUDE_STATS_FILE, 'utf-8'));
        res.json(fresh);
        return;
      }
      if (stats.lastComputedDate < todayStr()) updateStats();
      res.json(stats);
    } catch {
      // No cache file yet, rebuild and return empty for now
      updateStats();
      res.json({ version: STATS_SCHEMA_VERSION, dailyActivity: [], dailyModelTokens: [], modelUsage: {}, projectUsage: {}, totalSessions: 0, totalMessages: 0, hourCounts: {} });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Claude Activity Pings (from hooks) ---
const PINGS_FILE = path.join(DATA_DIR, 'claude-pings.json');
if (!existsSync(PINGS_FILE)) writeFileSync(PINGS_FILE, '[]');

app.post('/api/claude-ping', async (req, res) => {
  try {
    const b = req.body;
    const pings = JSON.parse(await fs.readFile(PINGS_FILE, 'utf-8'));
    pings.push({
      ts: new Date().toISOString(),
      session: b.session_id || 'unknown',
      project: b.cwd ? path.basename(b.cwd) : 'unknown',
    });
    // Keep last 90 days (~keep generous, trim if > 50k)
    if (pings.length > 50000) pings.splice(0, pings.length - 50000);
    await writeJSON(PINGS_FILE, pings);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/claude-pings', async (_req, res) => {
  try {
    res.json(JSON.parse(await fs.readFile(PINGS_FILE, 'utf-8')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Career System: LLM cost observability
// See META/.../01-foundation/03-llm-cost-observability
// ─────────────────────────────────────────────────────────────

// Zod schema — input record (ts auto-filled server-side)
const CostRecordInput = z.object({
  caller: z.string().min(1),             // e.g. 'evaluator:stage-a', 'tailor', 'applier'
  model: z.string().min(1),              // e.g. 'claude-haiku-4-5', 'claude-sonnet-4-6'
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),    // caller computes (model price × tokens)
  session_id: z.string().optional(),
  job_id: z.string().optional(),
});

async function appendCostRecord(input) {
  const parsed = CostRecordInput.parse(input);  // throws ZodError on bad input
  const record = { ts: new Date().toISOString(), ...parsed };
  await fs.appendFile(LLM_COSTS_FILE, JSON.stringify(record) + '\n');
  return record;
}

async function readCostRecords({ start, end, caller, model } = {}) {
  let raw = '';
  try { raw = await fs.readFile(LLM_COSTS_FILE, 'utf-8'); } catch { return []; }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {
      console.warn('[llm-costs] skipping malformed line:', line.slice(0, 80));
    }
  }
  return records.filter(r => {
    if (start && r.ts < start) return false;
    if (end && r.ts > end) return false;
    if (caller && r.caller !== caller) return false;
    if (model && r.model !== model) return false;
    return true;
  });
}

function aggregateCosts(records, groupBy) {
  if (!groupBy) {
    return records.reduce((acc, r) => {
      acc.total_cost += r.cost_usd;
      acc.total_tokens += r.input_tokens + r.output_tokens;
      acc.record_count += 1;
      return acc;
    }, { total_cost: 0, total_tokens: 0, record_count: 0 });
  }
  const buckets = {};
  for (const r of records) {
    let key;
    if (groupBy === 'day') key = r.ts.slice(0, 10);
    else if (groupBy === 'caller') key = r.caller;
    else if (groupBy === 'model') key = r.model;
    else throw new Error(`Unsupported groupBy: ${groupBy}`);
    if (!buckets[key]) buckets[key] = { total_cost: 0, total_tokens: 0, record_count: 0 };
    buckets[key].total_cost += r.cost_usd;
    buckets[key].total_tokens += r.input_tokens + r.output_tokens;
    buckets[key].record_count += 1;
  }
  return buckets;
}

// POST /api/career/llm-costs — caller appends a record
app.post('/api/career/llm-costs', async (req, res) => {
  try {
    const record = await appendCostRecord(req.body);
    res.status(201).json(record);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid record', details: e.issues });
    }
    res.status(500).json({ error: e.message });
  }
});

// GET /api/career/llm-costs
//   (no query)        → today's aggregate { total_cost, total_tokens, record_count }
//   ?start=&end=      → ISO range filter
//   ?caller= / ?model= → exact match filter
//   ?groupBy=day|caller|model → bucketed aggregate
app.get('/api/career/llm-costs', async (req, res) => {
  try {
    const { start, end, caller, model, groupBy } = req.query;
    let filterStart = start, filterEnd = end;
    // Default (no query params): today aggregate (local timezone day start → now)
    const defaultMode = !start && !end && !caller && !model && !groupBy;
    if (defaultMode) {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      filterStart = todayStart.toISOString();
    }
    const records = await readCostRecords({ start: filterStart, end: filterEnd, caller, model });
    if (groupBy) return res.json(aggregateCosts(records, groupBy));
    if (defaultMode) return res.json(aggregateCosts(records));
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Career System: Identity (你是谁) — data/career/identity.yml
// See META/.../02-profile/01-identity
// ─────────────────────────────────────────────────────────────

// Partial-save design (m3): allow incremental save.
// All strings accept empty; arrays min 0. Format checks (email/URL) happen
// on frontend (malformed blocks save). Backend is permissive — shape is
// validated, content is not. Applier/Evaluator re-check completeness at
// use-time before consuming identity.
// Bounds (DoS protection): same conventions as PreferencesSchema below —
// strings ≤ 200 chars, arrays ≤ 50 entries.
const ID_STR = z.string().max(200);

const EducationEntrySchema = z.object({
  school: ID_STR.optional(),
  degree: ID_STR.optional(),
  graduation: ID_STR.optional(),
  gpa: ID_STR.optional(),
});

const LanguageEntrySchema = z.object({
  lang: ID_STR.optional(),
  level: z.enum(['Native', 'Fluent', 'Conversational', 'Basic']).optional(),
});

// Permissive: every field optional so a curl PUT with `{}` succeeds (matches
// the m3 partial-save spec). Frontend's BLANK_IDENTITY supplies defaults for
// boolean/object fields. Applier MUST re-check completeness at use-time.
const IdentitySchema = z.object({
  name: ID_STR.optional(),
  email: ID_STR.optional(),               // format-check done on frontend
  phone: ID_STR.optional(),
  links: z.object({
    linkedin: ID_STR.optional(),          // URL format-check done on frontend
    github: ID_STR.optional(),
    portfolio: ID_STR.optional(),
  }).optional(),
  location: z.object({
    current_city: ID_STR.optional(),
    current_country: ID_STR.optional(),
  }).optional(),
  legal: z.object({
    visa_status: ID_STR.optional(),
    visa_expiration: ID_STR.optional(),
    needs_sponsorship_now: z.boolean().optional(),
    needs_sponsorship_future: z.boolean().optional(),
    authorized_us_yes_no: z.boolean().optional(),
    citizenship: ID_STR.optional(),
  }).optional(),
  education: z.array(EducationEntrySchema).max(50).optional(),
  languages: z.array(LanguageEntrySchema).max(50).optional(),
});

async function readIdentity() {
  try {
    const raw = await fs.readFile(IDENTITY_FILE, 'utf-8');
    if (!raw.trim()) return null;
    return yaml.load(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeIdentity(obj) {
  const parsed = IdentitySchema.parse(obj);
  const yamlText = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
  await atomicWriteFile(IDENTITY_FILE, yamlText);
  return parsed;
}

// GET — returns current identity or null if not yet created
app.get('/api/career/identity', async (_req, res) => {
  try {
    const identity = await readIdentity();
    res.json(identity);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT — replaces identity fully (zod-validated)
app.put('/api/career/identity', async (req, res) => {
  try {
    const saved = await writeIdentity(req.body);
    res.json(saved);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid identity', details: e.issues });
    }
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Career System: Preferences (你想要什么) — data/career/preferences.yml
// See META/.../02-profile/02-preferences
// ─────────────────────────────────────────────────────────────

// Partial-save design (same as identity m3): permissive schema — structure
// validated but content not. Missing fields don't block save; format errors
// caught on frontend. Finder/Evaluator re-check completeness at use-time.
//
// Bounds (DoS protection): strings capped 200 chars, arrays 200 entries —
// way over any realistic personal-use ceiling. Caps stop a malformed PUT or
// abusive /preview body from blocking the event loop.
const STR = z.string().max(200);
const STRS = z.array(STR).max(200);

const TargetRoleSchema = z.object({
  title: STR,
  seniority: STR,
  function: STR.optional(),
});

const CompTargetSchema = z.object({
  base_min: z.number().optional(),
  base_max: z.number().optional(),
  total_min: z.number().optional(),
  total_max: z.number().optional(),
  currency: STR,
});

const LocationPrefSchema = z.object({
  accept_any: z.boolean(),
  remote_only: z.boolean(),
  hybrid_max_days_onsite: z.number().optional(),
  preferred_cities: STRS,
  acceptable_countries: STRS,
});

const HardFiltersSchema = z.object({
  source_filter: z.object({
    blocked_sources: STRS,
  }),
  company_blocklist: STRS,
  title_blocklist: STRS,
  title_allowlist: STRS,
  location: z.object({
    allowed_countries: STRS,
    allowed_cities: STRS,
    disallowed_countries: STRS,
  }),
  seniority: z.object({
    allowed: STRS,
  }),
  posted_within_days: z.number(),
  comp_floor: z.object({
    base_min: z.number().optional(),
    total_min: z.number().optional(),
    currency: STR,
  }),
  jd_text_blocklist: STRS,
});

const SoftPreferencesSchema = z.object({
  company_types: STRS,
  remote_culture: STRS,
  tech_stack_preferred: STRS,
  tech_stack_avoid: STRS,
  industries_preferred: STRS,
  industries_avoid: STRS,
});

const ScoringWeightsSchema = z.object({
  tech_match: z.number(),
  comp_match: z.number(),
  location_match: z.number(),
  company_match: z.number(),
  growth_signal: z.number(),
});

const ThresholdsSchema = z.object({
  strong: z.number(),
  worth: z.number(),
  consider: z.number(),
  skip_below: z.number(),
});

const EvaluatorStrategySchema = z.object({
  stage_a: z.object({
    enabled: z.boolean(),
    model: STR,
    threshold: z.number(),
  }),
  stage_b: z.object({
    enabled: z.boolean(),
    model: STR,
    blocks: z.object({
      block_b: z.boolean(),
      block_c: z.boolean(),
      block_d: z.boolean(),
      block_e: z.boolean(),
      block_f: z.boolean(),
      block_g: z.boolean(),
    }),
  }),
});

const PreferencesSchema = z.object({
  targets: z.array(TargetRoleSchema).max(50),
  comp_target: CompTargetSchema,
  location: LocationPrefSchema,
  hard_filters: HardFiltersSchema,
  soft_preferences: SoftPreferencesSchema,
  scoring_weights: ScoringWeightsSchema,
  thresholds: ThresholdsSchema,
  evaluator_strategy: EvaluatorStrategySchema,
});

function defaultPreferences() {
  return {
    targets: [],
    comp_target: {
      currency: 'USD',
    },
    location: {
      accept_any: false,
      remote_only: false,
      preferred_cities: [],
      acceptable_countries: [],
    },
    hard_filters: {
      source_filter: { blocked_sources: [] },
      company_blocklist: [],
      title_blocklist: [],
      title_allowlist: [],
      location: {
        allowed_countries: [],
        allowed_cities: [],
        disallowed_countries: [],
      },
      seniority: { allowed: [] },
      posted_within_days: 0,
      comp_floor: { currency: 'USD' },
      jd_text_blocklist: [],
    },
    soft_preferences: {
      company_types: [],
      remote_culture: [],
      tech_stack_preferred: [],
      tech_stack_avoid: [],
      industries_preferred: [],
      industries_avoid: [],
    },
    scoring_weights: {
      tech_match: 0.2,
      comp_match: 0.2,
      location_match: 0.2,
      company_match: 0.2,
      growth_signal: 0.2,
    },
    thresholds: {
      strong: 4.5,
      worth: 4.0,
      consider: 3.5,
      skip_below: 3.0,
    },
    evaluator_strategy: {
      stage_a: {
        enabled: true,
        model: 'claude-haiku-4-5',
        threshold: 3.5,
      },
      stage_b: {
        enabled: true,
        model: 'claude-sonnet-4-6',
        blocks: {
          block_b: true,
          block_c: false,
          block_d: false,
          block_e: true,
          block_f: false,
          block_g: false,
        },
      },
    },
  };
}

async function readPreferences() {
  try {
    const raw = await fs.readFile(PREFERENCES_FILE, 'utf-8');
    if (!raw.trim()) return defaultPreferences();
    const loaded = yaml.load(raw);
    return deepMerge(defaultPreferences(), loaded);
  } catch (e) {
    if (e.code === 'ENOENT') return defaultPreferences();
    throw e;
  }
}

async function writePreferences(obj) {
  const parsed = PreferencesSchema.parse(obj);
  const yamlText = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
  await atomicWriteFile(PREFERENCES_FILE, yamlText);
  return parsed;
}

// GET — returns current preferences or defaultPreferences() if file missing
app.get('/api/career/preferences', async (_req, res) => {
  try {
    const prefs = await readPreferences();
    res.json(prefs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT — replaces preferences fully (zod-validated)
app.put('/api/career/preferences', async (req, res) => {
  try {
    const saved = await writePreferences(req.body);
    res.json(saved);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid preferences', details: e.issues });
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/career/preferences/preview
// Dry-run stub: estimates how many jobs the submitted hard_filters would drop.
// Body: full Preferences object (client sends current form state to preview unsaved edits).
// Returns: { total_jobs, would_drop, would_pass, new_drops, breakdown[], stub: true }
// Real pipeline dry-run ships with 05-finder/03-dedupe-hard-filter; this stub
// lets UI be built and tested now. Drops are estimated proportionally to the
// number of non-empty filter entries (not real pipeline evaluation).
app.post('/api/career/preferences/preview', async (req, res) => {
  try {
    // Validate shape but don't require exact schema match (preview accepts
    // unsaved form state which may have partial/invalid data — malformed
    // numbers should not crash the preview).
    const prefs = req.body;
    if (!prefs || !prefs.hard_filters) {
      return res.status(400).json({ error: 'Missing hard_filters in body' });
    }
    const hf = prefs.hard_filters;
    const TOTAL = 100;

    // Rough heuristic: each non-empty filter contributes some drops.
    // Intentionally overlap-aware via min() clamp.
    const ruleDrops = [
      { rule: 'source_filter', drops: (hf.source_filter?.blocked_sources?.length || 0) * 3 },
      { rule: 'company_blocklist', drops: (hf.company_blocklist?.length || 0) * 2 },
      { rule: 'title_blocklist', drops: (hf.title_blocklist?.length || 0) * 2 },
      { rule: 'title_allowlist', drops: hf.title_allowlist?.length ? Math.max(0, 15 - hf.title_allowlist.length * 2) : 0 },
      { rule: 'location', drops: ((hf.location?.allowed_countries?.length ? 5 : 0) + (hf.location?.disallowed_countries?.length || 0) * 3) },
      { rule: 'seniority', drops: hf.seniority?.allowed?.length ? Math.max(0, 10 - hf.seniority.allowed.length * 2) : 0 },
      { rule: 'posted_within_days', drops: hf.posted_within_days > 0 && hf.posted_within_days < 14 ? 8 : 0 },
      { rule: 'comp_floor', drops: (hf.comp_floor?.base_min || hf.comp_floor?.total_min) ? 6 : 0 },
      { rule: 'jd_text_blocklist', drops: (hf.jd_text_blocklist?.length || 0) * 2 },
    ];

    let wouldDrop = 0;
    const breakdown = ruleDrops.map(r => {
      const d = Math.min(r.drops, TOTAL - wouldDrop);
      wouldDrop += d;
      return { rule: r.rule, drops: d };
    });
    wouldDrop = Math.min(wouldDrop, TOTAL);

    // new_drops: compare vs currently-persisted preferences
    let newDrops = 0;
    try {
      const saved = await readPreferences();
      const savedHf = saved.hard_filters || {};
      // crude: diff counts by comparing total blocklist sizes
      const currNonEmpty =
        (hf.company_blocklist?.length || 0) + (hf.title_blocklist?.length || 0) +
        (hf.source_filter?.blocked_sources?.length || 0) + (hf.jd_text_blocklist?.length || 0);
      const savedNonEmpty =
        (savedHf.company_blocklist?.length || 0) + (savedHf.title_blocklist?.length || 0) +
        (savedHf.source_filter?.blocked_sources?.length || 0) + (savedHf.jd_text_blocklist?.length || 0);
      newDrops = Math.max(0, Math.min(wouldDrop, (currNonEmpty - savedNonEmpty) * 2));
    } catch { newDrops = 0; }

    res.json({
      total_jobs: TOTAL,
      would_drop: wouldDrop,
      would_pass: TOTAL - wouldDrop,
      new_drops: newDrops,
      breakdown,
      stub: true,
      note: 'Mock data. Real pipeline dry-run ships with 05-finder/03-dedupe-hard-filter.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Career System: Narrative & Proof Points — knowledge markdown docs
// narrative.md (你的 north star / 写作风格) + proof-points.md (项目 / 文章 / OSS)
// 两份都 commit 进 git。骨架 H2 是下游 Evaluator/CV-Tailor 抽取段落的软契约 —
// 改 H2 名前要看 META/.../02-profile/03-narrative-proof
// ─────────────────────────────────────────────────────────────

const DEFAULT_NARRATIVE = `# Narrative

## Origin
_例如：本科学统计，工作两年发现自己更喜欢 ship product 而不是写论文，
后来转去做 infra，发现把模糊系统问题想清楚比调一个模型更让我满足。1-2 段。_

## Superpowers
_例如：把模糊业务问题拆成可执行系统 — 在 X 项目里把 30 个边界条件
梳理成 5 条短路规则，让 oncall 时间从每周 8h 降到 1h。每条 1-2 段 + 一个具体例子。_

## North Star
_例如：5 年内做能影响 100k+ 开发者日常工作流的 infra 工具；
长期想 build 一家把工程师从重复性工作里解放出来的公司。_

## Voice & Style
_例如：偏好短句直给结论 + bullet list 列证据；不用 emoji；
技术细节默认折叠；写 cover letter 倾向 1 段定位 + 1 段为什么这家公司，避免套话。_
`;

const DEFAULT_PROOF_POINTS = `# Proof Points

## Shipped Projects
_例如：_
_- **Foo Pipeline** — 把 ETL 延迟从 2h 降到 5min，日处理 80M 行（[github](https://github.com/...)）_
_- **Bar Dashboard** — 给 200+ 内部用户用，省下每周 12h 手工对账时间_

## Writing
_例如：_
_- [How we cut Postgres tail latency by 80%](https://...) — Hacker News top 5_
_- 内部 tech talk：实时数据架构演进（150 人参加）_

## Open Source
_例如：_
_- **owner/repo** maintainer — 18k stars, 230 contributors, 40 releases_
_- **other/lib** core contributor — 实现 streaming 模式，被 X 公司生产采用_

## Quantified Wins
_例如：_
_- 把 P99 latency 从 800ms 降到 120ms（在 30 天内，无新增机器）_
_- 把新员工 onboarding 时长从 3 天压到 4 小时_
_- 主导 migration 把 5 个 monolith 拆成 12 个 service，无 downtime_
`;

async function readMarkdownDoc(file, fallback) {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

async function writeMarkdownDoc(file, content) {
  if (typeof content !== 'string') {
    throw new TypeError('content must be a string');
  }
  await atomicWriteFile(file, content);
}

app.get('/api/career/narrative', async (_req, res) => {
  try {
    res.json({ content: await readMarkdownDoc(NARRATIVE_FILE, DEFAULT_NARRATIVE) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/career/narrative', async (req, res) => {
  try {
    await writeMarkdownDoc(NARRATIVE_FILE, req.body?.content);
    res.json({ content: req.body.content });
  } catch (e) {
    if (e instanceof TypeError) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/career/proof-points', async (_req, res) => {
  try {
    res.json({ content: await readMarkdownDoc(PROOF_POINTS_FILE, DEFAULT_PROOF_POINTS) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/career/proof-points', async (req, res) => {
  try {
    await writeMarkdownDoc(PROOF_POINTS_FILE, req.body?.content);
    res.json({ content: req.body.content });
  } catch (e) {
    if (e instanceof TypeError) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Career System: QA Bank — three-layer storage
//   data/career/qa-bank/legal.yml      — 法律/EEO/visa 固定答案 (gitignored)
//   data/career/qa-bank/templates.md   — 开放题模板库 (committed)
//   data/career/qa-bank/history.jsonl  — 每次 apply Q&A append-only (gitignored)
// See META/.../02-profile/04-qa-bank
// ─────────────────────────────────────────────────────────────

// Permissive partial-save (same convention as IdentitySchema). All fields
// optional so curl PUT {} succeeds. Frontend BLANK_LEGAL provides defaults.
const QALegalSchema = z.object({
  work_authorization: z.object({
    status: ID_STR.optional(),
    expiration: ID_STR.optional(),
    requires_sponsorship_now: z.boolean().optional(),
    requires_sponsorship_future: z.boolean().optional(),
    authorized_us_yes_no: z.boolean().optional(),
    citizenship: ID_STR.optional(),
  }).optional(),
  eeo: z.object({
    gender: ID_STR.optional(),
    ethnicity: ID_STR.optional(),
    veteran: ID_STR.optional(),
    disability: ID_STR.optional(),
    pronouns: ID_STR.optional(),
  }).optional(),
  personal: z.object({
    age_18_plus: z.boolean().optional(),
    criminal_record: z.boolean().optional(),
    can_pass_background_check: z.boolean().optional(),
    can_pass_drug_test: z.boolean().optional(),
    relocate_willing: z.boolean().optional(),
    travel_willing_percent: z.number().min(0).max(100).optional(),
  }).optional(),
  how_did_you_hear_default: ID_STR.optional(),
});

function defaultLegal() {
  return {
    work_authorization: {},
    eeo: {},
    personal: {},
    how_did_you_hear_default: '',
  };
}

async function readLegal() {
  try {
    const raw = await fs.readFile(QA_LEGAL_FILE, 'utf-8');
    if (!raw.trim()) return defaultLegal();
    return deepMerge(defaultLegal(), yaml.load(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return defaultLegal();
    throw e;
  }
}

async function writeLegal(obj) {
  const parsed = QALegalSchema.parse(obj);
  const yamlText = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
  await atomicWriteFile(QA_LEGAL_FILE, yamlText);
  return parsed;
}

app.get('/api/career/qa-bank/legal', async (_req, res) => {
  try { res.json(await readLegal()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/career/qa-bank/legal', async (req, res) => {
  try { res.json(await writeLegal(req.body)); }
  catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid legal', details: e.issues });
    res.status(500).json({ error: e.message });
  }
});

// Templates — markdown text, same shape as narrative/proof-points endpoints.
// File is committed (templates.md tracked in git as the example seed).
app.get('/api/career/qa-bank/templates', async (_req, res) => {
  try { res.json({ content: await readMarkdownDoc(QA_TEMPLATES_FILE, '') }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/career/qa-bank/templates', async (req, res) => {
  try {
    await writeMarkdownDoc(QA_TEMPLATES_FILE, req.body?.content);
    res.json({ content: req.body.content });
  } catch (e) {
    if (e instanceof TypeError) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// History — append-only jsonl. Each line = one Q&A interaction during apply.
// field_type powers per-class flywheel analysis; model_used powers cost-vs-quality.
const QAHistoryFieldType = z.enum(['legal', 'open', 'eeo', 'other']);

const QAHistoryRecordSchema = z.object({
  ts: z.string().max(40).optional(),     // ISO 8601; server fills if omitted
  job_id: z.string().max(200).optional(),
  company: z.string().max(200).optional(),
  role: z.string().max(200).optional(),
  field_type: QAHistoryFieldType,
  q: z.string().max(2000),
  a_draft: z.string().max(5000).optional(),
  a_final: z.string().max(5000).optional(),
  edit_distance: z.number().optional(),
  template_used: z.string().max(200).optional(),
  model_used: z.string().max(80).optional(),
});

async function appendHistoryRecord(rec) {
  const parsed = QAHistoryRecordSchema.parse(rec);
  if (!parsed.ts) parsed.ts = new Date().toISOString();
  await fs.appendFile(QA_HISTORY_FILE, JSON.stringify(parsed) + '\n', 'utf-8');
  return parsed;
}

async function readHistoryRecords({ limit = 100, q } = {}) {
  let raw;
  try { raw = await fs.readFile(QA_HISTORY_FILE, 'utf-8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (!raw.trim()) return [];
  const lines = raw.split('\n').filter(l => l.trim());
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  let filtered = records;
  if (q) {
    const needle = String(q).toLowerCase();
    filtered = records.filter(r => {
      const hay = `${r.q || ''} ${r.a_final || ''} ${r.a_draft || ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }
  // Most recent first, capped at limit
  return filtered.slice(-Math.max(1, Math.min(1000, Number(limit) || 100))).reverse();
}

app.post('/api/career/qa-bank/history', async (req, res) => {
  try { res.json(await appendHistoryRecord(req.body)); }
  catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid history record', details: e.issues });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/career/qa-bank/history', async (req, res) => {
  try { res.json(await readHistoryRecords({ limit: req.query.limit, q: req.query.q })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────
// Career System: Renderer — markdown → CV-template HTML transformer
// 04-renderer/02-markdown-to-template — debug endpoint. Real PDF pipeline
// (04-renderer/01) imports markdownToTemplateHtml directly via function call.
// ─────────────────────────────────────────────────────────────
app.post('/api/career/render/markdown', (req, res) => {
  const content = req.body?.content;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  // 256KB cap already enforced globally on /api/career/* — defensive bound here
  // for the day someone bumps the global cap and forgets resume markdown can grow.
  if (content.length > 500_000) {
    return res.status(413).json({ error: 'content too large (>500KB)' });
  }
  try {
    const html = markdownToTemplateHtml(content);
    res.json({ html, allowed_tags: ALLOWED_TAGS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CV PDF endpoint — the real renderer entry point.
// Pipeline: resume markdown → markdownToTemplateHtml → composeCvHtml (with
// identity.yml-driven header) → htmlToPdf → application/pdf stream.
// Caller (CV editor preview / tailor-engine output / applier upload) decides
// what to do with the bytes; renderer keeps no on-disk state.
app.post('/api/career/render/pdf', async (req, res) => {
  const md = req.body?.resume_markdown;
  if (typeof md !== 'string') {
    return res.status(400).json({ error: 'resume_markdown must be a string' });
  }
  if (md.length > 500_000) {
    return res.status(413).json({ error: 'resume_markdown too large (>500KB)' });
  }
  try {
    const identity = (await readIdentity()) ?? {};
    const body_html = markdownToTemplateHtml(md);
    const options = req.body?.options ?? {};
    const html = composeCvHtml({ identity, body_html, options });
    const pdf = await htmlToPdf(html, {
      format: options.format,
      margin: options.margin,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="resume.pdf"');
    res.send(pdf);
  } catch (e) {
    console.warn('render/pdf failed:', e.message);
    res.status(503).json({ error: e.message });
  }
});

// HTML → PDF smoke endpoint. Low-level debug tool for the Playwright pipeline.
// /api/career/render/pdf above is the real entry point for CV rendering.
app.post('/api/career/render/_test-html-to-pdf', async (req, res) => {
  const html = req.body?.html;
  if (typeof html !== 'string') {
    return res.status(400).json({ error: 'html must be a string' });
  }
  if (html.length > 1_000_000) {
    return res.status(413).json({ error: 'html too large (>1MB)' });
  }
  try {
    const pdf = await htmlToPdf(html, {
      format: req.body?.format,
      margin: req.body?.margin,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdf);
  } catch (e) {
    // Browser launch failures and chromium-not-installed land here.
    console.warn('htmlToPdf failed:', e.message);
    res.status(503).json({ error: e.message });
  }
});

// Clean shutdown: kill chromium subprocess on Ctrl+C / docker stop / nodemon
// restart. Without this, Playwright leaves zombie browsers eating RAM.
let _shuttingDown = false;
async function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`Received ${signal}, shutting down chromium...`);
  await shutdownBrowser();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- Compute dailyCost from JSONL session files and write to DAILY_COST_FILE ---
const MODEL_PRICING = {
  'claude-opus-4-6':            { input: 15,   output: 75,  cacheRead: 1.875, cacheWrite: 18.75 },
  'claude-opus-4-5-20251101':   { input: 15,   output: 75,  cacheRead: 1.875, cacheWrite: 18.75 },
  'claude-sonnet-4-6':          { input: 3,    output: 15,  cacheRead: 0.375, cacheWrite: 3.75  },
  'claude-sonnet-4-5-20250929': { input: 3,    output: 15,  cacheRead: 0.375, cacheWrite: 3.75  },
  'claude-haiku-4-5-20251001':  { input: 0.80, output: 4,   cacheRead: 0.08,  cacheWrite: 1.0   },
};

async function computeDailyCost() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const dailyCost = {}; // date -> { model -> costUSD }

  // Collect all JSONL files recursively
  async function collectJsonl(dir) {
    const results = [];
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...await collectJsonl(full));
      else if (entry.name.endsWith('.jsonl')) results.push(full);
    }
    return results;
  }

  const files = await collectJsonl(projectsDir);
  for (const filePath of files) {
    try {
      const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.type !== 'assistant') continue;
        const ts = record.timestamp;
        if (!ts) continue;
        const dt = new Date(ts);
        const date = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
        const msg = record.message || {};
        const model = msg.model;
        const usage = msg.usage;
        if (!model || !usage) continue;
        const p = MODEL_PRICING[model];
        if (!p) continue;
        const cost = (
          (usage.input_tokens || 0) * p.input +
          (usage.output_tokens || 0) * p.output +
          (usage.cache_read_input_tokens || 0) * p.cacheRead +
          (usage.cache_creation_input_tokens || 0) * p.cacheWrite
        ) / 1_000_000;
        if (!dailyCost[date]) dailyCost[date] = {};
        dailyCost[date][model] = (dailyCost[date][model] || 0) + cost;
      }
    } catch { /* skip unreadable files */ }
  }

  const dailyCostArr = Object.keys(dailyCost).sort().map(date => ({
    date,
    costByModel: dailyCost[date],
  }));

  // Write to our own file, never touch stats-cache
  await fs.writeFile(DAILY_COST_FILE, JSON.stringify(dailyCostArr), 'utf-8');
  console.log(`dailyCost computed: ${dailyCostArr.length} days`);
}

// Run on startup, then every 10 minutes
computeDailyCost();
setInterval(computeDailyCost, 10 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// Career System: Resume Index — multi-resume management
// 03-cv-engine/01-resume-index — data layer for tailored CVs.
//   index.yml                    — list of all base resumes (committed)
//   {id}/metadata.yml            — match rules / emphasize / renderer (committed)
//   {id}/base.md                 — resume markdown content (gitignored)
//   {id}/versions/               — auto-snapshots on edit (gitignored)
// ─────────────────────────────────────────────────────────────

// Slug regex enforced everywhere. Matches the documented constraint and is
// the first line of defense against path traversal — `..` and `/` can't
// satisfy this character class.
const RESUME_ID_RE = /^[a-z0-9-]{1,40}$/;
const RESERVED_RESUME_IDS = new Set(['index']); // collides with index.yml

function validateResumeId(id) {
  return typeof id === 'string'
    && RESUME_ID_RE.test(id)
    && !RESERVED_RESUME_IDS.has(id);
}

// Belt-and-suspenders: regex would already block `..`/`/`, but resolve+prefix
// check guards against anything sneaky a future schema relaxation might allow.
function resolveResumeDir(id) {
  if (!validateResumeId(id)) {
    const e = new Error('invalid resume id');
    e.status = 400;
    throw e;
  }
  const dir = path.resolve(RESUMES_DIR, id);
  if (!dir.startsWith(RESUMES_DIR + path.sep) && dir !== RESUMES_DIR) {
    const e = new Error('invalid resume path');
    e.status = 400;
    throw e;
  }
  return dir;
}

const ResumeIndexEntrySchema = z.object({
  id: z.string().regex(RESUME_ID_RE),
  title: z.string().max(200),
  description: z.string().max(500).optional(),
  source: z.enum(['manual', 'google_doc']),
  gdoc_id: z.string().max(200).optional(),
  last_synced_at: z.string().max(40).optional(),
  is_default: z.boolean(),
  created_at: z.string().max(40),
});

const ResumeIndexSchema = z.object({
  resumes: z.array(ResumeIndexEntrySchema).max(50),
});

const MatchRulesSchema = z.object({
  role_keywords: z.array(z.string().max(100)).max(50).default([]),
  jd_keywords: z.array(z.string().max(100)).max(50).default([]),
  negative_keywords: z.array(z.string().max(100)).max(50).default([]),
});

const EmphasizeSchema = z.object({
  projects: z.array(z.string().max(100)).max(50).default([]),
  skills: z.array(z.string().max(100)).max(50).default([]),
  narrative: z.string().max(2000).optional(),
});

const RendererConfigSchema = z.object({
  template: z.string().max(50).default('default'),
  font: z.string().max(50).optional(),
  accent_color: z.string().max(20).default('#0969da'),
});

const ResumeMetadataSchema = z.object({
  archetype: z.string().max(100).optional(),
  match_rules: MatchRulesSchema.default({}),
  emphasize: EmphasizeSchema.default({}),
  renderer: RendererConfigSchema.default({}),
});

const NewResumeSchema = z.object({
  id: z.string().regex(RESUME_ID_RE),
  title: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  source: z.enum(['manual', 'google_doc']),
  gdoc_id: z.string().max(200).optional(),
  set_default: z.boolean().optional(),
});

// H2 sections here are a soft contract with downstream consumers
// (04-renderer's CV template + future 03-cv-engine tailor-engine + 04-auto-select
//  match-rule extractors) — keep them aligned with narrative/proof-points
// skeletons.
const DEFAULT_BASE_MD = `# Resume

## Experience

_例如：_
_- **Company** — Title (Month YYYY – Month YYYY)_
_  - Bullet 1_
_  - Bullet 2_

## Education

_例如：_
_- **University** — Degree (YYYY)_

## Skills

_例如：_
_- Languages: ..._
_- Frameworks: ..._

## Projects

_例如：_
_- **Project name** — one-line description._
`;

async function readResumeIndex() {
  try {
    const raw = await fs.readFile(RESUMES_INDEX_FILE, 'utf-8');
    if (!raw.trim()) return { resumes: [] };
    const loaded = yaml.load(raw);
    return ResumeIndexSchema.parse(loaded ?? { resumes: [] });
  } catch (e) {
    if (e.code === 'ENOENT') return { resumes: [] };
    throw e;
  }
}

async function writeResumeIndex(idx) {
  const parsed = ResumeIndexSchema.parse(idx);
  const yamlText = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
  await atomicWriteFile(RESUMES_INDEX_FILE, yamlText);
  return parsed;
}

async function readResumeMetadata(id) {
  const dir = resolveResumeDir(id);
  const file = path.join(dir, 'metadata.yml');
  try {
    const raw = await fs.readFile(file, 'utf-8');
    if (!raw.trim()) return ResumeMetadataSchema.parse({});
    return ResumeMetadataSchema.parse(yaml.load(raw) ?? {});
  } catch (e) {
    if (e.code === 'ENOENT') return ResumeMetadataSchema.parse({});
    throw e;
  }
}

async function writeResumeMetadata(id, obj) {
  const dir = resolveResumeDir(id);
  const file = path.join(dir, 'metadata.yml');
  const parsed = ResumeMetadataSchema.parse(obj);
  const yamlText = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
  await atomicWriteFile(file, yamlText);
  return parsed;
}

// GET — full index
app.get('/api/career/resumes', async (_req, res) => {
  try {
    res.json(await readResumeIndex());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST — create new resume (dir + metadata.yml + base.md skeleton + index entry)
app.post('/api/career/resumes', async (req, res) => {
  try {
    const parsed = NewResumeSchema.parse(req.body);
    if (RESERVED_RESUME_IDS.has(parsed.id)) {
      return res.status(400).json({ error: `id "${parsed.id}" is reserved` });
    }
    const idx = await readResumeIndex();
    if (idx.resumes.some(r => r.id === parsed.id)) {
      return res.status(409).json({ error: `id "${parsed.id}" already in use` });
    }
    const dir = resolveResumeDir(parsed.id);
    await fs.mkdir(path.join(dir, 'versions'), { recursive: true });
    await writeResumeMetadata(parsed.id, {});
    await atomicWriteFile(path.join(dir, 'base.md'), DEFAULT_BASE_MD);

    const newEntry = {
      id: parsed.id,
      title: parsed.title,
      description: parsed.description,
      source: parsed.source,
      gdoc_id: parsed.gdoc_id,
      is_default: false,
      created_at: new Date().toISOString(),
    };
    let resumes = idx.resumes.slice();
    if (parsed.set_default) {
      resumes = resumes.map(r => ({ ...r, is_default: false }));
      newEntry.is_default = true;
    }
    resumes.push(newEntry);
    await writeResumeIndex({ resumes });

    res.status(201).json(newEntry);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid resume', details: e.issues });
    }
    if (e.status === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE — remove from index + rm dir (recursive, no archive)
app.delete('/api/career/resumes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!validateResumeId(id)) return res.status(400).json({ error: 'invalid id' });
    const idx = await readResumeIndex();
    const before = idx.resumes.length;
    const next = idx.resumes.filter(r => r.id !== id);
    if (next.length === before) return res.status(404).json({ error: 'not found' });
    await writeResumeIndex({ resumes: next });
    const dir = resolveResumeDir(id);
    await fs.rm(dir, { recursive: true, force: true });
    res.json({ deleted: id });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PATCH — set is_default atomically (exactly one default at a time)
app.patch('/api/career/resumes/:id/set-default', async (req, res) => {
  try {
    const { id } = req.params;
    if (!validateResumeId(id)) return res.status(400).json({ error: 'invalid id' });
    const idx = await readResumeIndex();
    if (!idx.resumes.some(r => r.id === id)) return res.status(404).json({ error: 'not found' });
    const next = {
      resumes: idx.resumes.map(r => ({ ...r, is_default: r.id === id })),
    };
    await writeResumeIndex(next);
    res.json(next);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET / PUT metadata
app.get('/api/career/resumes/:id/metadata', async (req, res) => {
  try {
    res.json(await readResumeMetadata(req.params.id));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/career/resumes/:id/metadata', async (req, res) => {
  try {
    const idx = await readResumeIndex();
    if (!idx.resumes.some(r => r.id === req.params.id)) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json(await writeResumeMetadata(req.params.id, req.body));
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid metadata', details: e.issues });
    }
    if (e.status === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/duplicate — atomic clone of metadata + fresh base.md skeleton.
// Semantics: "start a new direction from this archetype" — copies match rules
// / emphasize / renderer config but NOT base.md content. If the user wants
// to clone the actual resume body, paste-import once 03-in-ui-editor lands.
app.post('/api/career/resumes/:id/duplicate', async (req, res) => {
  try {
    const sourceId = req.params.id;
    if (!validateResumeId(sourceId)) return res.status(400).json({ error: 'invalid source id' });

    const newId = req.body?.new_id;
    if (!validateResumeId(newId)) return res.status(400).json({ error: 'invalid new_id (slug only, max 40)' });
    if (RESERVED_RESUME_IDS.has(newId)) return res.status(400).json({ error: `id "${newId}" is reserved` });

    const idx = await readResumeIndex();
    const source = idx.resumes.find(r => r.id === sourceId);
    if (!source) return res.status(404).json({ error: 'source not found' });
    if (idx.resumes.some(r => r.id === newId)) {
      return res.status(409).json({ error: `id "${newId}" already in use` });
    }

    const sourceMetadata = await readResumeMetadata(sourceId);
    const newDir = resolveResumeDir(newId);
    await fs.mkdir(path.join(newDir, 'versions'), { recursive: true });
    await writeResumeMetadata(newId, sourceMetadata);
    await atomicWriteFile(path.join(newDir, 'base.md'), DEFAULT_BASE_MD);

    const newTitle = (typeof req.body?.new_title === 'string' && req.body.new_title.trim())
      ? req.body.new_title.trim().slice(0, 200)
      : `${source.title} (copy)`;
    const newEntry = {
      id: newId,
      title: newTitle,
      description: source.description,
      source: 'manual',  // duplicates are always manual; gdoc link is unique
      is_default: false,
      created_at: new Date().toISOString(),
    };
    await writeResumeIndex({ resumes: [...idx.resumes, newEntry] });
    res.status(201).json(newEntry);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Resume content + versions + render
// 03-cv-engine/03-in-ui-editor — full editor pipeline.
//   GET /:id/content                  base.md text + versions list
//   PUT /:id/content                  snapshot prior + atomic write + FIFO 50
//   GET /:id/versions/:filename       single snapshot read
//   GET /:id/render                   PDF stream (reads base.md + identity +
//                                     metadata.renderer → composeCvHtml →
//                                     htmlToPdf)
// ─────────────────────────────────────────────────────────────

const VERSION_FILENAME_RE = /^[0-9TZ\-:.]{10,40}\.md$/i;
const VERSIONS_CAP = 50;

// ISO 8601 with colons replaced by dashes — keeps lexical sort + filename-safe.
function isoSnapshotFilename() {
  return new Date().toISOString().replace(/:/g, '-') + '.md';
}

async function listResumeVersions(id) {
  const dir = path.join(resolveResumeDir(id), 'versions');
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const entries = [];
  for (const filename of names) {
    if (!VERSION_FILENAME_RE.test(filename)) continue;
    try {
      const stat = await fs.stat(path.join(dir, filename));
      entries.push({
        filename,
        ts: stat.mtime.toISOString(),
        size: stat.size,
      });
    } catch { /* skip unreadable */ }
  }
  // Newest first.
  entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return entries;
}

// FIFO eviction once cap is exceeded. Called after a fresh snapshot is written.
async function pruneResumeVersions(id) {
  const dir = path.join(resolveResumeDir(id), 'versions');
  const entries = await listResumeVersions(id);
  if (entries.length <= VERSIONS_CAP) return;
  // Drop the oldest (entries are newest-first).
  const toDelete = entries.slice(VERSIONS_CAP);
  for (const e of toDelete) {
    await fs.rm(path.join(dir, e.filename), { force: true }).catch(() => {});
  }
}

async function readResumeContent(id) {
  const baseFile = path.join(resolveResumeDir(id), 'base.md');
  try {
    return await fs.readFile(baseFile, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return DEFAULT_BASE_MD;
    throw e;
  }
}

// GET — returns content + versions list (newest first).
app.get('/api/career/resumes/:id/content', async (req, res) => {
  try {
    const { id } = req.params;
    if (!validateResumeId(id)) return res.status(400).json({ error: 'invalid id' });
    const idx = await readResumeIndex();
    if (!idx.resumes.some(r => r.id === id)) return res.status(404).json({ error: 'not found' });
    const [content, versions] = await Promise.all([
      readResumeContent(id),
      listResumeVersions(id),
    ]);
    res.json({ content, versions });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PUT — pre-write snapshot of current base.md, then atomic write new content,
// then FIFO-prune versions/ to VERSIONS_CAP.
app.put('/api/career/resumes/:id/content', async (req, res) => {
  try {
    const { id } = req.params;
    if (!validateResumeId(id)) return res.status(400).json({ error: 'invalid id' });
    const content = req.body?.content;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    if (content.length > 500_000) {
      return res.status(413).json({ error: 'content too large (>500KB)' });
    }
    const idx = await readResumeIndex();
    if (!idx.resumes.some(r => r.id === id)) return res.status(404).json({ error: 'not found' });

    const dir = resolveResumeDir(id);
    const baseFile = path.join(dir, 'base.md');
    const versionsDir = path.join(dir, 'versions');
    await fs.mkdir(versionsDir, { recursive: true });

    let snapshotName = null;
    try {
      const previous = await fs.readFile(baseFile, 'utf-8');
      if (previous.trim().length > 0) {
        snapshotName = isoSnapshotFilename();
        await atomicWriteFile(path.join(versionsDir, snapshotName), previous);
      }
    } catch (e) {
      // If base.md doesn't exist yet, skip the snapshot — first save.
      if (e.code !== 'ENOENT') throw e;
    }

    await atomicWriteFile(baseFile, content);
    await pruneResumeVersions(id);

    res.json({ content, snapshot: snapshotName });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET single version — used by m3 versions UI for restore preview.
app.get('/api/career/resumes/:id/versions/:filename', async (req, res) => {
  try {
    const { id, filename } = req.params;
    if (!validateResumeId(id)) return res.status(400).json({ error: 'invalid id' });
    // basename + regex defence — refuses anything that isn't a snapshot filename.
    const safe = path.basename(filename);
    if (!VERSION_FILENAME_RE.test(safe)) {
      return res.status(400).json({ error: 'invalid version filename' });
    }
    const file = path.join(resolveResumeDir(id), 'versions', safe);
    let content;
    try {
      content = await fs.readFile(file, 'utf-8');
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'version not found' });
      throw e;
    }
    const stat = await fs.stat(file);
    res.json({ content, ts: stat.mtime.toISOString(), size: stat.size });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET render — full PDF pipeline keyed by resume id (m2 iframe src targets this).
// Reads from disk so the PDF reflects ground truth; ?v=ts is just a cache buster.
app.get('/api/career/resumes/:id/render', async (req, res) => {
  try {
    const { id } = req.params;
    if (!validateResumeId(id)) return res.status(400).json({ error: 'invalid id' });
    const idx = await readResumeIndex();
    if (!idx.resumes.some(r => r.id === id)) return res.status(404).json({ error: 'not found' });

    const [identity, metadata, content] = await Promise.all([
      readIdentity().then(v => v ?? {}),
      readResumeMetadata(id),
      readResumeContent(id),
    ]);
    const body_html = markdownToTemplateHtml(content);
    const html = composeCvHtml({
      identity,
      body_html,
      options: { accent_color: metadata.renderer?.accent_color },
    });
    const pdf = await htmlToPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${id}.pdf"`);
    res.send(pdf);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.warn(`render/${req.params.id} failed:`, e.message);
    res.status(503).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Auto-select base resume — keyword scoring against a JD.
// 03-cv-engine/04-auto-select. No LLM; transparent + free + deterministic.
// Score = +1 per role_keyword matched in role + +1 per jd_keyword matched
// in jd_text − 2 per negative_keyword matched in jd_text.
// Ties broken by is_default first, then created_at ascending.
// ─────────────────────────────────────────────────────────────

const AutoSelectRequestSchema = z.object({
  jd_text: z.string().max(50_000),
  role: z.string().max(200).optional(),
});

// Lower-case substring match. Each keyword counted once even if it appears
// multiple times — prevents JDs that repeat a word from inflating the score.
function matchKeywords(haystack, keywords) {
  if (!keywords || keywords.length === 0) return [];
  const hay = haystack.toLowerCase();
  const matched = [];
  for (const kw of keywords) {
    const k = String(kw).toLowerCase().trim();
    if (k && hay.includes(k)) matched.push(kw);
  }
  return matched;
}

function scoreResumeAgainstJd(metadata, jd_text, role) {
  const rules = metadata?.match_rules ?? {};
  const role_text = role ?? '';
  const role_matched = matchKeywords(role_text, rules.role_keywords);
  const jd_matched = matchKeywords(jd_text, rules.jd_keywords);
  const negative_matched = matchKeywords(jd_text, rules.negative_keywords);
  const score = role_matched.length + jd_matched.length - 2 * negative_matched.length;
  return {
    score,
    matched: {
      role_keywords: role_matched,
      jd_keywords: jd_matched,
      negative_keywords: negative_matched,
    },
  };
}

function buildPickReason(top) {
  const { score, matched, is_default } = top;
  const role_n = matched.role_keywords.length;
  const jd_n = matched.jd_keywords.length;
  const neg_n = matched.negative_keywords.length;
  if (score > 0) {
    const parts = [];
    if (role_n) parts.push(`${role_n} role keyword${role_n > 1 ? 's' : ''}`);
    if (jd_n) parts.push(`${jd_n} jd keyword${jd_n > 1 ? 's' : ''}`);
    let reason = `Matched ${parts.join(', ')}`;
    if (neg_n) reason += `, ${neg_n} negative penalty`;
    return reason;
  }
  if (score === 0) {
    return is_default
      ? 'No positive matches; using default resume'
      : 'No positive matches; tie-broken by created_at';
  }
  return 'Best available has net-negative match; review match_rules';
}

app.post('/api/career/resumes/auto-select', async (req, res) => {
  try {
    const parsed = AutoSelectRequestSchema.parse(req.body);
    const idx = await readResumeIndex();
    if (idx.resumes.length === 0) {
      return res.status(404).json({ error: 'No resumes registered' });
    }

    const rankings = [];
    for (const r of idx.resumes) {
      const md = await readResumeMetadata(r.id);
      const { score, matched } = scoreResumeAgainstJd(md, parsed.jd_text, parsed.role);
      rankings.push({
        id: r.id,
        title: r.title,
        score,
        matched,
        is_default: r.is_default,
        created_at: r.created_at,
      });
    }

    rankings.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);
    });

    const top = rankings[0];
    const fallback_to_default = top.score <= 0 && top.is_default;

    res.json({
      picked: top.id,
      picked_score: top.score,
      picked_reason: buildPickReason(top),
      fallback_to_default,
      rankings,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid auto-select request', details: e.issues });
    }
    res.status(500).json({ error: e.message });
  }
});

// ─── Finder: scan trigger + status ─────────────────────────────────────
app.post('/api/career/finder/scan', (_req, res) => {
  try {
    const { scan_id, started_at } = startScan();
    res.status(202).json({ scan_id, started_at });
  } catch (e) {
    if (e instanceof ScanAlreadyRunningError) {
      return res.status(409).json({
        error: 'scan already running',
        ...e.state,
      });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/career/finder/scan/status', (_req, res) => {
  res.json(getScanStatus());
});

// ─── Finder: portals.yml CRUD ──────────────────────────────────────────
app.get('/api/career/finder/portals', async (_req, res) => {
  try {
    const cfg = await readPortalsConfig();
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/career/finder/portals', async (req, res) => {
  try {
    await writePortalsConfig(req.body);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid portals config', details: e.issues });
    }
    res.status(500).json({ error: e.message });
  }
});

// ─── Pipeline: manual paste ────────────────────────────────────────────
const ManualPasteSchema = z.object({
  url: z.string().url().max(2000),
  title: z.string().max(500).optional(),
  note: z.string().max(2000).optional(),
});

app.post('/api/career/pipeline/manual', async (req, res) => {
  try {
    const body = ManualPasteSchema.parse(req.body);
    const job = await manualPaste(body);

    // Append to pipeline.json (read-modify-write under simple lock would be
    // ideal; here we accept last-writer-wins since manual paste is interactive
    // and unlikely to race with a scan write).
    let current = { jobs: [], last_scan_at: null, scan_summary: [] };
    if (existsSync(PIPELINE_FILE)) {
      try {
        current = JSON.parse(await fs.readFile(PIPELINE_FILE, 'utf-8'));
      } catch {
        current = { jobs: [], last_scan_at: null, scan_summary: [] };
      }
    }
    if (!Array.isArray(current.jobs)) current.jobs = [];
    // Replace existing manual entry for same id (idempotent re-paste).
    current.jobs = current.jobs.filter((j) => j.id !== job.id);
    current.jobs.push(job);
    await atomicWriteFile(PIPELINE_FILE, JSON.stringify(current, null, 2));

    res.status(201).json({ job });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid manual paste', details: e.issues });
    }
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`API server on :${port}`));
