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

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(REPOS_FILE)) writeFileSync(REPOS_FILE, '[]');
if (!existsSync(CONFIG_FILE)) writeFileSync(CONFIG_FILE, '{}');

// Helpers
async function readJSON(file) { return JSON.parse(await fs.readFile(file, 'utf-8')); }
async function writeJSON(file, data) { await fs.writeFile(file, JSON.stringify(data, null, 2)); }

function parseGitHubUrl(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/\s?#]+)/);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null;
}

// Simple in-memory cache (5 min TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function githubFetch(endpoint) {
  const cached = cache.get(endpoint);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;

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
        // Get all branches
        const branches = await githubFetch(`/repos/${repo.id}/branches?per_page=100`);
        const branchList = Array.isArray(branches) ? branches : [];

        // Fetch commits from each branch in parallel
        const branchResults = await Promise.allSettled(
          branchList.map(async (branch) => {
            let endpoint = `/repos/${repo.id}/commits?sha=${encodeURIComponent(branch.name)}&per_page=100`;
            if (since) endpoint += `&since=${since}`;
            if (until) endpoint += `&until=${until}`;
            if (author) endpoint += `&author=${author}`;
            const commits = await githubFetch(endpoint);
            return { branch: branch.name, commits: Array.isArray(commits) ? commits : [] };
          })
        );

        // Deduplicate by SHA, keep branch info
        const seen = new Map();
        for (const br of branchResults) {
          if (br.status !== 'fulfilled') continue;
          for (const c of br.value.commits) {
            if (!seen.has(c.sha)) {
              seen.set(c.sha, {
                sha: c.sha,
                message: c.commit.message,
                author: c.commit.author.name,
                date: c.commit.author.date,
                url: c.html_url,
                branch: br.value.branch,
              });
            }
          }
        }

        return {
          repo: repo.id,
          repoUrl: repo.url,
          branches: branchList.map(b => b.name),
          commits: [...seen.values()].sort((a, b) => b.date.localeCompare(a.date)),
        };
      })
    );

    const activity = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') activity.push(r.value);
      else errors.push({ repo: repos[i].id, error: r.reason?.message || 'Unknown error' });
    });

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
            additions: pr.additions,
            deletions: pr.deletions,
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
const DEFAULT_LEARN_DIR = path.resolve(__dirname, '..');

// Initialize learn-dirs.json with default if missing
if (!existsSync(LEARN_DIRS_FILE)) {
  writeFileSync(LEARN_DIRS_FILE, JSON.stringify([
    { id: 'learn', name: 'Learn', path: DEFAULT_LEARN_DIR }
  ], null, 2));
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
  if (!fullPath.startsWith(dir.path)) throw new Error('Path traversal');
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
      // For the default learn dir, ignore 'learn-dashboard' subfolder
      const ignore = d.path === DEFAULT_LEARN_DIR ? ['learn-dashboard'] : [];
      const children = await buildTree(d.path, '', ignore);
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

async function rebuildStats() {
  if (statsRebuilding) return;
  statsRebuilding = true;
  try {
    // Token + cost data comes from ccusage (live LiteLLM pricing).
    // This function still owns: dailyActivity, hourCounts, sessions, longestSession,
    // and the encoded-dir → cwd map used for project display names.
    const dailyActivity = {};
    const hourCounts = {};
    const sessions = new Set();
    let firstDate = null;
    const sessionMeta = {};
    const projectCwd = {}; // encoded project dir name -> real cwd path

    const projectDirs = await fs.readdir(CLAUDE_PROJECTS_DIR).catch(() => []);
    for (const projDir of projectDirs) {
      const projPath = path.join(CLAUDE_PROJECTS_DIR, projDir);
      const stat = await fs.stat(projPath).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const files = await collectJsonlFiles(projPath);

      for (const filePath of files) {
        const sessionId = path.basename(filePath, '.jsonl');
        const isSubagent = filePath.includes('/subagents/');
        try {
          const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
          for await (const line of rl) {
            if (!line.trim()) continue;
            let record;
            try { record = JSON.parse(line); } catch { continue; }
            // Capture cwd the first time we see one in this project dir
            if (!projectCwd[projDir] && typeof record.cwd === 'string' && record.cwd) {
              projectCwd[projDir] = record.cwd;
            }
            const ts = record.timestamp;
            if (!ts) continue;
            const localDate = new Date(ts);
            const date = `${localDate.getFullYear()}-${String(localDate.getMonth()+1).padStart(2,'0')}-${String(localDate.getDate()).padStart(2,'0')}`;
            const hour = localDate.getHours();

            if (record.type === 'user' && record.userType === 'external' && !isSubagent) {
              sessions.add(sessionId);
              if (!dailyActivity[date]) dailyActivity[date] = { messages: 0, sessions: new Set(), toolCalls: 0 };
              dailyActivity[date].sessions.add(sessionId);
              if (!sessionMeta[sessionId]) sessionMeta[sessionId] = { start: ts, end: ts, messageCount: 0 };
              sessionMeta[sessionId].messageCount++;
              sessionMeta[sessionId].end = ts;
              if (!firstDate || date < firstDate) firstDate = date;
            }

            if (record.type === 'assistant') {
              if (!dailyActivity[date]) dailyActivity[date] = { messages: 0, sessions: new Set(), toolCalls: 0 };
              dailyActivity[date].messages++;
              hourCounts[hour] = (hourCounts[hour] || 0) + 1;
              const msg = record.message || {};
              if (msg.content && Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  if (block.type === 'tool_use') dailyActivity[date].toolCalls++;
                }
              }
            }
          }
        } catch { /* skip unreadable */ }
      }
    }

    const sortedDates = Object.keys(dailyActivity).sort();
    const dailyActivityArr = sortedDates.map(date => ({ date, messageCount: dailyActivity[date].messages, sessionCount: dailyActivity[date].sessions.size, toolCallCount: dailyActivity[date].toolCalls }));

    let longestSession = null;
    for (const [sid, meta] of Object.entries(sessionMeta)) {
      const duration = new Date(meta.end) - new Date(meta.start);
      if (!longestSession || duration > longestSession.duration) longestSession = { sessionId: sid, duration, messageCount: meta.messageCount, timestamp: meta.start };
    }

    // Pull token + cost data from ccusage (live LiteLLM pricing — no manual price table).
    // Single `--instances` call provides per-project data; daily/model totals are
    // reconstructed by summing across projects (verified to match plain `daily` output).
    // If ccusage isn't installed, fall back to empty token/cost data so activity still renders.
    let dailyModelTokensArr = [];
    let dailyCostArr = [];
    let modelUsage = {};
    let totalCost = 0;
    let projectUsage = {};
    try {
      const out = execSync('ccusage daily --instances --json', { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
      const ccusageJson = JSON.parse(out);

      // Per-day rollup buckets for the existing chart fields
      const tokensByDate = {};   // date -> { model -> tokenSum }
      const costByDate = {};     // date -> { model -> cost }

      for (const [encodedDir, entries] of Object.entries(ccusageJson.projects || {})) {
        // Project-level aggregation
        let projTotalCost = 0;
        const projModels = {};   // modelName -> { outputTokens, costUSD }
        const projDates = new Set();
        let projFirstDate = null;
        let projLastDate = null;

        for (const entry of entries) {
          const date = entry.date;
          projDates.add(date);
          if (!projFirstDate || date < projFirstDate) projFirstDate = date;
          if (!projLastDate || date > projLastDate) projLastDate = date;

          for (const m of entry.modelBreakdowns) {
            // Per-project per-model
            if (!projModels[m.modelName]) projModels[m.modelName] = { outputTokens: 0, costUSD: 0 };
            projModels[m.modelName].outputTokens += m.outputTokens;
            projModels[m.modelName].costUSD += m.cost;
            projTotalCost += m.cost;

            // Global per-day per-model rollup (replaces what `daily --json` used to give us)
            if (!tokensByDate[date]) tokensByDate[date] = {};
            tokensByDate[date][m.modelName] = (tokensByDate[date][m.modelName] || 0)
              + m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens;
            if (!costByDate[date]) costByDate[date] = {};
            costByDate[date][m.modelName] = (costByDate[date][m.modelName] || 0) + m.cost;

            // Global per-model rollup
            if (!modelUsage[m.modelName]) {
              modelUsage[m.modelName] = {
                inputTokens: 0, outputTokens: 0,
                cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
                costUSD: 0, webSearchRequests: 0, contextWindow: 0, maxOutputTokens: 0,
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

        totalCost += projTotalCost;

        // Filter: only surface projects with ≥ $5 total spend
        if (projTotalCost >= 5) {
          const cwd = projectCwd[encodedDir];
          const displayName = cwd ? path.basename(cwd) : encodedDir;
          projectUsage[encodedDir] = {
            displayName,
            cwd: cwd || null,
            totalCostUSD: projTotalCost,
            daysActive: projDates.size,
            firstActivity: projFirstDate,
            lastActivity: projLastDate,
            models: projModels,
          };
        }
      }

      dailyModelTokensArr = Object.keys(tokensByDate).sort().map(date => ({ date, tokensByModel: tokensByDate[date] }));
      dailyCostArr = Object.keys(costByDate).sort().map(date => ({ date, costByModel: costByDate[date] }));
    } catch (e) {
      console.error('ccusage failed — token/cost data omitted. Install via `brew install ccusage` or `npm i -g ccusage`.', e.message);
    }

    const earliestDate = sortedDates.length > 0 ? sortedDates[0] : firstDate;

    const result = {
      version: 4, lastComputedDate: todayStr(),
      dailyActivity: dailyActivityArr, dailyModelTokens: dailyModelTokensArr, dailyCost: dailyCostArr,
      modelUsage, projectUsage, totalSessions: sessions.size,
      totalMessages: dailyActivityArr.reduce((s, d) => s + d.messageCount, 0),
      totalCostUSD: totalCost, longestSession,
      firstSessionDate: earliestDate ? new Date(earliestDate).toISOString() : null,
      hourCounts, totalSpeculationTimeSavedMs: 0, shotDistribution: {},
    };

    await fs.writeFile(CLAUDE_STATS_FILE, JSON.stringify(result), 'utf-8');
    console.log(`Stats rebuilt: ${sessions.size} sessions, ${result.totalMessages} messages`);
  } catch (e) {
    console.error('Stats rebuild failed:', e.message);
  } finally {
    statsRebuilding = false;
  }
}

// Rebuild on server start
rebuildStats();

const STATS_SCHEMA_VERSION = 4;

app.get('/api/claude-stats', async (_req, res) => {
  try {
    // Trigger async rebuild if stale (date) or schema mismatch
    try {
      const raw = await fs.readFile(CLAUDE_STATS_FILE, 'utf-8');
      const stats = JSON.parse(raw);
      const schemaStale = (stats.version ?? 0) < STATS_SCHEMA_VERSION;
      if (schemaStale) {
        // Schema mismatch: force synchronous rebuild so the client gets fresh data immediately
        await rebuildStats();
        const fresh = JSON.parse(await fs.readFile(CLAUDE_STATS_FILE, 'utf-8'));
        res.json(fresh);
        return;
      }
      if (stats.lastComputedDate < todayStr()) rebuildStats();
      res.json(stats);
    } catch {
      // No cache file yet, rebuild and return empty for now
      rebuildStats();
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

app.listen(8000, () => console.log('API server on :8000'));
