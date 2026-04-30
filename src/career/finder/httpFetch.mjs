// Robots-aware HTTP fetcher shared by all source adapters.
// Server-only. Uses node:fetch (Node ≥ 18).

export const USER_AGENT =
  'learn-dashboard career-system/1.0 (+https://github.com/V1ctor2182/basecamp)';

export class RobotsBlockedError extends Error {
  constructor(url, rule) {
    super(`Blocked by robots.txt: ${url} (rule: ${rule})`);
    this.name = 'RobotsBlockedError';
    this.url = url;
    this.rule = rule;
  }
}

export class HttpFetchError extends Error {
  constructor(url, status, body) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpFetchError';
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

// Per-scan cache: domain → array of disallowed path prefixes (case-sensitive).
// resetRobotsCache() must be called by scanRunner before each scan.
let robotsCache = new Map();

export function resetRobotsCache() {
  robotsCache = new Map();
}

function parseRobotsTxt(txt) {
  // Simple parser: collect Disallow rules under blocks targeting our UA or '*'.
  // Last block wins on conflicts within a UA group is overkill — we OR all
  // applicable blocks. Allow lines are not honored (rare in practice for the
  // public ATS / GitHub raw domains we hit).
  const lines = txt.split(/\r?\n/);
  const groups = [];
  let current = null;
  for (let raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || current.disallows.length > 0) {
        current = { agents: [], disallows: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'disallow' && current) {
      if (value !== '') current.disallows.push(value);
    }
  }
  const ourAgent = USER_AGENT.toLowerCase();
  const disallowed = [];
  for (const g of groups) {
    const matches = g.agents.some(
      (a) => a === '*' || ourAgent.includes(a) || a.includes('learn-dashboard')
    );
    if (matches) disallowed.push(...g.disallows);
  }
  return disallowed;
}

async function getRobotsRules(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const robotsUrl = `${origin}/robots.txt`;
  let rules = [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(robotsUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok) {
      const txt = await res.text();
      rules = parseRobotsTxt(txt);
    }
    // Non-200 → treat as allow-all (common: 404 means no robots, allowed).
  } catch {
    // Network or parse error → fail-open (allow). Logged by caller if it cares.
  }
  robotsCache.set(origin, rules);
  return rules;
}

export async function checkRobots(url) {
  const u = new URL(url);
  const rules = await getRobotsRules(u.origin);
  for (const rule of rules) {
    if (u.pathname.startsWith(rule)) {
      throw new RobotsBlockedError(url, rule);
    }
  }
}

// Fetches a URL with our UA, robots check, timeout, and body-size cap.
// Returns { status, headers, text(), json() }. Throws RobotsBlockedError /
// HttpFetchError / AbortError on failure.
export async function httpFetch(url, opts = {}) {
  const { timeout = 10_000, maxBytes = 1_048_576, headers = {} } = opts;
  await checkRobots(url);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpFetchError(url, res.status, body.slice(0, 500));
  }

  // Read body up to maxBytes via streaming reader.
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return wrapResponse(res, text.slice(0, maxBytes));
  }
  const chunks = [];
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (received >= maxBytes) {
      try { await reader.cancel(); } catch {}
      break;
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const text = buf.slice(0, maxBytes).toString('utf-8');
  return wrapResponse(res, text);
}

function wrapResponse(res, text) {
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    text,
    json: () => JSON.parse(text),
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
