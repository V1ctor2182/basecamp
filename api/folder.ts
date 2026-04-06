import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './_lib/supabase.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { path: dirPath } = req.body
  if (!dirPath) return res.status(400).json({ error: 'Missing path' })

  // Create all parent directories
  const parts = dirPath.split('/')
  let current = ''
  for (const part of parts) {
    const parentPath = current
    current = current ? `${current}/${part}` : part
    await supabase.from('documents').upsert({
      path: current,
      name: part,
      parent_path: parentPath,
      type: 'dir',
    }, { onConflict: 'path' })
  }

  res.json({ ok: true })
}
