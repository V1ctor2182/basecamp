import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './_lib/supabase.js'

function parseGitHubUrl(url: string) {
  const m = url.match(/github\.com\/([^/]+)\/([^/\s?#]+)/)
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('repos')
      .select('*')
      .order('added_at')

    if (error) return res.status(500).json({ error: error.message })
    return res.json(data || [])
  }

  if (req.method === 'POST') {
    const parsed = parseGitHubUrl(req.body.url)
    if (!parsed) return res.status(400).json({ error: 'Invalid GitHub URL' })

    const id = `${parsed.owner}/${parsed.repo}`

    const { data: existing } = await supabase
      .from('repos')
      .select('id')
      .eq('id', id)
      .single()

    if (existing) return res.status(409).json({ error: 'Repo already tracked' })

    const newRepo = {
      id,
      url: `https://github.com/${id}`,
      owner: parsed.owner,
      repo: parsed.repo,
    }

    const { error } = await supabase.from('repos').insert(newRepo)
    if (error) return res.status(500).json({ error: error.message })

    return res.json({ ...newRepo, added_at: new Date().toISOString() })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
