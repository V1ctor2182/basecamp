import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './_lib/supabase.js'
import { getGitHubToken, githubFetch } from './_lib/github.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { since, until, author } = req.query as Record<string, string>
  const token = await getGitHubToken()

  const { data: repos } = await supabase.from('repos').select('*')
  if (!repos || repos.length === 0) return res.json({ activity: [], errors: [] })

  const results = await Promise.allSettled(
    repos.map(async (repo) => {
      const branches = await githubFetch(`/repos/${repo.id}/branches?per_page=100`, token)
      const branchList = Array.isArray(branches) ? branches : []

      const branchResults = await Promise.allSettled(
        branchList.map(async (branch: { name: string }) => {
          let endpoint = `/repos/${repo.id}/commits?sha=${encodeURIComponent(branch.name)}&per_page=100`
          if (since) endpoint += `&since=${since}`
          if (until) endpoint += `&until=${until}`
          if (author) endpoint += `&author=${author}`
          const commits = await githubFetch(endpoint, token)
          return { branch: branch.name, commits: Array.isArray(commits) ? commits : [] }
        })
      )

      const seen = new Map()
      for (const br of branchResults) {
        if (br.status !== 'fulfilled') continue
        for (const c of br.value.commits) {
          if (!seen.has(c.sha)) {
            seen.set(c.sha, {
              sha: c.sha,
              message: c.commit.message,
              author: c.commit.author.name,
              date: c.commit.author.date,
              url: c.html_url,
              branch: br.value.branch,
            })
          }
        }
      }

      return {
        repo: repo.id,
        repoUrl: repo.url,
        branches: branchList.map((b: { name: string }) => b.name),
        commits: [...seen.values()].sort((a, b) => b.date.localeCompare(a.date)),
      }
    })
  )

  const activity: unknown[] = []
  const errors: unknown[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') activity.push(r.value)
    else errors.push({ repo: repos[i].id, error: r.reason?.message || 'Unknown error' })
  })

  res.json({ activity, errors })
}
