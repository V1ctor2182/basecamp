import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Data files
const DATA_DIR = path.join(__dirname, 'data');
const REPOS_FILE = path.join(DATA_DIR, 'repos.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const COMMIT_STATS_FILE = path.join(DATA_DIR, 'commit-stats.json');
const PR_STATS_FILE = path.join(DATA_DIR, 'pr-stats.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(REPOS_FILE)) writeFileSync(REPOS_FILE, '[]');
if (!existsSync(CONFIG_FILE)) writeFileSync(CONFIG_FILE, '{}');
if (!existsSync(COMMIT_STATS_FILE)) writeFileSync(COMMIT_STATS_FILE, '{}');
if (!existsSync(PR_STATS_FILE)) writeFileSync(PR_STATS_FILE, '{}');

// Helpers
async function readJSON(file) { return JSON.parse(await fs.readFile(file, 'utf-8')); }
async function writeJSON(file, data) { await fs.writeFile(file, JSON.stringify(data, null, 2)); }

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
        // Fetch commits from default branch (1 request per repo, not N per branch)
        let endpoint = `/repos/${repo.id}/commits?per_page=100`;
        if (since) endpoint += `&since=${since}`;
        if (until) endpoint += `&until=${until}`;
        if (author) endpoint += `&author=${author}`;
        const commits = await githubFetch(endpoint);
        const commitList = Array.isArray(commits) ? commits : [];

        return {
          repo: repo.id,
          repoUrl: repo.url,
          branches: [],
          commits: commitList.map(c => ({
            sha: c.sha,
            message: c.commit.message,
            author: c.commit.author.name,
            date: c.commit.committer.date,
            url: c.html_url,
            branch: '',
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
      writeJSON(COMMIT_STATS_FILE, _commitStats).catch(() => {});
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
      writeJSON(PR_STATS_FILE, _prStats).catch(() => {});
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

const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`API server on :${port}`));
