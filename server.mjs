import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
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

  const res = await fetch(`https://api.github.com${endpoint}`, { headers });
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

// --- Sync all repos where user has commits ---
app.post('/api/repos/sync', async (req, res) => {
  try {
    const config = await readJSON(CONFIG_FILE);
    const username = config.githubUsername;
    if (!username) return res.status(400).json({ error: 'Set GitHub username in settings first' });

    const repoSet = new Map(); // id -> repo metadata

    // 1. All repos owned by user (including private if token available)
    for (let page = 1; page <= 3; page++) {
      const data = await githubFetch(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const gh of data) {
        repoSet.set(gh.full_name, gh);
      }
    }

    // 2. Recent push events (up to ~10 pages = 300 events) to find repos in other orgs
    for (let page = 1; page <= 10; page++) {
      const events = await githubFetch(`/users/${username}/events?per_page=30&page=${page}`);
      if (!Array.isArray(events) || events.length === 0) break;
      for (const event of events) {
        if (event.type === 'PushEvent' && event.repo) {
          const [owner, repo] = event.repo.name.split('/');
          if (!repoSet.has(event.repo.name)) {
            // Fetch repo metadata
            const gh = await githubFetch(`/repos/${event.repo.name}`).catch(() => null);
            if (gh && gh.full_name) repoSet.set(gh.full_name, gh);
          }
        }
      }
    }

    // 3. Filter: only repos where user has at least one commit
    const repos = await readJSON(REPOS_FILE);
    const existingIds = new Set(repos.map(r => r.id));
    let added = 0;
    let checked = 0;

    const candidates = [...repoSet.values()].filter(gh => !existingIds.has(gh.full_name));

    await Promise.allSettled(candidates.map(async (gh) => {
      try {
        const commits = await githubFetch(`/repos/${gh.full_name}/commits?author=${username}&per_page=1`);
        checked++;
        if (!Array.isArray(commits) || commits.length === 0) return;
        repos.push({
          id: gh.full_name,
          url: gh.html_url,
          owner: gh.owner.login,
          repo: gh.name,
          addedAt: new Date().toISOString(),
        });
        added++;
      } catch (e) { /* skip inaccessible repos */ }
    }));

    await writeJSON(REPOS_FILE, repos);
    res.json({ ok: true, added, total: repos.length, checked });
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

// --- Claude Usage Stats ---
app.get('/api/claude-stats', async (_req, res) => {
  try {
    const statsPath = path.join(os.homedir(), '.claude', 'stats-cache.json');
    const raw = await fs.readFile(statsPath, 'utf-8');
    res.json(JSON.parse(raw));
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
