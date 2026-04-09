import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './_lib/supabase.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { path: itemPath } = req.body
  if (!itemPath) return res.status(400).json({ error: 'Missing path' })

  // Find the item and all children (for directories)
  const { data: items } = await supabase
    .from('documents')
    .select('path, type')
    .or(`path.eq.${itemPath},path.like.${itemPath}/%`)

  if (!items || items.length === 0) return res.status(404).json({ error: 'Not found' })

  // Delete files from storage
  const filePaths = items.filter(i => i.type === 'file').map(i => i.path)
  if (filePaths.length > 0) {
    await supabase.storage.from('documents').remove(filePaths)
  }

  // Delete all metadata rows
  const allPaths = items.map(i => i.path)
  await supabase
    .from('documents')
    .delete()
    .in('path', allPaths)

  res.json({ ok: true })
}
