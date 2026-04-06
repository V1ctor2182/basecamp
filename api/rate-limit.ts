import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getGitHubToken, githubFetch } from './_lib/github.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const token = await getGitHubToken()
  const data = await githubFetch('/rate_limit', token)
  res.json(data.rate || data)
}
