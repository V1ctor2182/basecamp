import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../_lib/supabase.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })

  const { owner, repo } = req.query
  const id = `${owner}/${repo}`

  const { error } = await supabase
    .from('repos')
    .delete()
    .eq('id', id)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
}
