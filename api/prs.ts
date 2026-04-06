import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './_lib/supabase.js'
import { getGitHubToken, githubFetch } from './_lib/github.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { since, author } = req.query as Record<string, string>
  const token = await getGitHubToken()

  const { data: repos } = await supabase.from('repos').select('*')
  if (!repos || repos.length === 0) return res.json({ prs: [], errors: [] })

  const results = await Promise.allSettled(
    repos.map(async (repo) => {
      const [openPRs, closedPRs] = await Promise.all([
        githubFetch(`/repos/${repo.id}/pulls?state=open&per_page=50&sort=updated&direction=desc`, token),
        githubFetch(`/repos/${repo.id}/pulls?state=closed&per_page=50&sort=updated&direction=desc`, token),
      ])

      const all = [
        ...(Array.isArray(openPRs) ? openPRs : []),
        ...(Array.isArray(closedPRs) ? closedPRs : []),
      ]

      let filtered = all
      if (author) {
        const a = author.toLowerCase()
        filtered = filtered.filter((pr: any) => pr.user?.login?.toLowerCase() === a)
      }
      if (since) {
        const sinceDate = new Date(since)
        filtered = filtered.filter((pr: any) => new Date(pr.updated_at) >= sinceDate)
      }

      return {
        repo: repo.id,
        repoUrl: repo.url,
        prs: filtered.map((pr: any) => ({
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
      }
    })
  )

  const prs: unknown[] = []
  const errors: unknown[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') prs.push(r.value)
    else errors.push({ repo: repos[i].id, error: r.reason?.message || 'Unknown error' })
  })

  res.json({ prs, errors })
}
