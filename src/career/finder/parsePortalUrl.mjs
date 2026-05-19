// Parse a Portals-page URL into the legacy {type, config} schema the
// adapter / scanRunner / portals.yml expect.
//
// 04-career-system / find-jobs-redesign m1 (Portals UX refactor).
//
// Supported domains:
//   - Greenhouse:  boards.greenhouse.io/<slug>            (also job-boards.greenhouse.io/<slug>
//                                                          and <slug>.boards.greenhouse.io)
//   - Ashby:       jobs.ashbyhq.com/<slug>
//   - Lever:       jobs.lever.co/<slug>
//   - GitHub-md:   github.com/<owner>/<repo>[/blob/<branch>/<path>]
//
// Unsupported → returns { error: '...' }.

/**
 * @param {string} input  URL as the user typed it
 * @returns {{ type: 'greenhouse'|'ashby'|'lever'|'github-md', config: object }
 *           | { error: string }}
 */
export function parsePortalUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    return { error: 'URL is empty' };
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return { error: 'Not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `Unsupported protocol ${url.protocol}` };
  }

  const host = url.hostname.toLowerCase();
  const segs = url.pathname.split('/').filter(Boolean);

  // ── Greenhouse ───────────────────────────────────────────────────────
  // Path form:  boards.greenhouse.io/<slug>[/jobs/<id>]
  //             job-boards.greenhouse.io/<slug>[/jobs/<id>]
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    const slug = segs[0];
    if (!slug) return { error: 'Greenhouse URL needs /<slug> path (e.g. /anthropic)' };
    return { type: 'greenhouse', config: { slug } };
  }
  // Subdomain form: <slug>.boards.greenhouse.io[/jobs/<id>]
  const ghSubMatch = host.match(/^([^.]+)\.boards\.greenhouse\.io$/);
  if (ghSubMatch) {
    return { type: 'greenhouse', config: { slug: ghSubMatch[1] } };
  }

  // ── Ashby ────────────────────────────────────────────────────────────
  // jobs.ashbyhq.com/<slug>[/...]
  if (host === 'jobs.ashbyhq.com') {
    const slug = segs[0];
    if (!slug) return { error: 'Ashby URL needs /<slug> path (e.g. /openai)' };
    return { type: 'ashby', config: { slug } };
  }

  // ── Lever ────────────────────────────────────────────────────────────
  // jobs.lever.co/<slug>[/...]
  if (host === 'jobs.lever.co') {
    const slug = segs[0];
    if (!slug) return { error: 'Lever URL needs /<slug> path (e.g. /stripe)' };
    return { type: 'lever', config: { slug } };
  }

  // ── GitHub-md ────────────────────────────────────────────────────────
  // Plain repo URL:   github.com/<owner>/<repo>
  // Folder/file URL:  github.com/<owner>/<repo>/blob/<branch>/<path...>
  // Raw URL:          raw.githubusercontent.com/<owner>/<repo>/<branch>/<path...>
  if (host === 'github.com') {
    const owner = segs[0];
    const repo = segs[1];
    if (!owner || !repo) {
      return { error: 'GitHub URL needs /<owner>/<repo> path' };
    }
    // /<owner>/<repo>/blob/<branch>/<rest...>
    let branch = 'main';
    let pathInRepo = 'README.md';
    if (segs[2] === 'blob' && segs[3]) {
      branch = segs[3];
      const rest = segs.slice(4);
      if (rest.length) pathInRepo = rest.join('/');
    }
    return {
      type: 'github-md',
      config: { owner, repo, path: pathInRepo, branch },
    };
  }
  if (host === 'raw.githubusercontent.com') {
    // /<owner>/<repo>/<branch>/<path...>
    const owner = segs[0];
    const repo = segs[1];
    const branch = segs[2];
    const rest = segs.slice(3);
    if (!owner || !repo || !branch || rest.length === 0) {
      return { error: 'Raw URL needs /<owner>/<repo>/<branch>/<path>' };
    }
    return {
      type: 'github-md',
      config: { owner, repo, path: rest.join('/'), branch },
    };
  }

  return {
    error:
      `Domain "${host}" not supported. Use boards.greenhouse.io, jobs.ashbyhq.com, jobs.lever.co, or github.com.`,
  };
}

/**
 * Reverse — reconstruct a display URL from the legacy {type, config} so
 * existing portals.yml entries render in the new URL-input UI.
 *
 * @returns {string|null}
 */
export function buildPortalUrl(type, config) {
  if (!config || typeof config !== 'object') return null;
  switch (type) {
    case 'greenhouse':
      return config.slug ? `https://boards.greenhouse.io/${config.slug}` : null;
    case 'ashby':
      return config.slug ? `https://jobs.ashbyhq.com/${config.slug}` : null;
    case 'lever':
      return config.slug ? `https://jobs.lever.co/${config.slug}` : null;
    case 'github-md':
      if (!config.owner || !config.repo) return null;
      // Build the file URL only when path is meaningful (non-default).
      // If path=README.md + branch=main (the defaults), keep the bare repo URL.
      if ((config.path === 'README.md' || !config.path) && (config.branch === 'main' || !config.branch)) {
        return `https://github.com/${config.owner}/${config.repo}`;
      }
      return `https://github.com/${config.owner}/${config.repo}/blob/${config.branch || 'main'}/${config.path || 'README.md'}`;
    default:
      return null;
  }
}
