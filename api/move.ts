import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './_lib/supabase.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { from, to } = req.body
  if (!from) return res.status(400).json({ error: 'Missing from path' })

  const name = from.includes('/') ? from.substring(from.lastIndexOf('/') + 1) : from
  const newPath = to ? `${to}/${name}` : name

  // Ensure target directory exists
  if (to) {
    const parts = to.split('/')
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
  }

  // Get item and all children
  const { data: items } = await supabase
    .from('documents')
    .select('*')
    .or(`path.eq.${from},path.like.${from}/%`)
    .order('path')

  for (const item of items || []) {
    const itemNewPath = item.path === from
      ? newPath
      : newPath + item.path.substring(from.length)
    const itemNewParent = item.path === from
      ? (to || '')
      : item.parent_path === from
        ? newPath
        : newPath + item.parent_path.substring(from.length)

    if (item.type === 'file') {
      await supabase.storage.from('documents').move(item.path, itemNewPath)
    }

    await supabase
      .from('documents')
      .update({
        path: itemNewPath,
        parent_path: itemNewParent,
        updated_at: new Date().toISOString(),
      })
      .eq('path', item.path)
  }

  res.json({ ok: true, newPath })
}
