import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase, buildTree } from './_lib/supabase.js'

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .order('path')

  if (error) return res.status(500).json({ error: error.message })
  res.json(buildTree(data || []))
}
