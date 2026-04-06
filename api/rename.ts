import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './_lib/supabase.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { path: itemPath, newName } = req.body
  if (!itemPath || !newName) return res.status(400).json({ error: 'Missing path or newName' })

  const parentPath = itemPath.includes('/') ? itemPath.substring(0, itemPath.lastIndexOf('/')) : ''
  const newPath = parentPath ? `${parentPath}/${newName}` : newName

  // Check if target already exists
  const { data: existing } = await supabase
    .from('documents')
    .select('id')
    .eq('path', newPath)
    .single()

  if (existing) return res.status(409).json({ error: 'Name already exists' })

  // Get the item to check its type
  const { data: item } = await supabase
    .from('documents')
    .select('type')
    .eq('path', itemPath)
    .single()

  if (!item) return res.status(404).json({ error: 'Not found' })

  if (item.type === 'file') {
    // Move file in storage
    await supabase.storage.from('documents').move(itemPath, newPath)
    // Update metadata
    await supabase
      .from('documents')
      .update({ path: newPath, name: newName, updated_at: new Date().toISOString() })
      .eq('path', itemPath)
  } else {
    // For directories, update the dir itself and all children
    const { data: children } = await supabase
      .from('documents')
      .select('*')
      .or(`path.eq.${itemPath},path.like.${itemPath}/%`)
      .order('path')

    for (const child of children || []) {
      const childNewPath = child.path === itemPath
        ? newPath
        : newPath + child.path.substring(itemPath.length)
      const childNewParent = child.parent_path === itemPath
        ? newPath
        : child.parent_path.startsWith(itemPath + '/')
          ? newPath + child.parent_path.substring(itemPath.length)
          : child.parent_path === parentPath && child.path === itemPath
            ? parentPath
            : child.parent_path

      if (child.type === 'file') {
        await supabase.storage.from('documents').move(child.path, childNewPath)
      }

      await supabase
        .from('documents')
        .update({
          path: childNewPath,
          name: child.path === itemPath ? newName : child.name,
          parent_path: child.path === itemPath ? parentPath : childNewParent,
          updated_at: new Date().toISOString(),
        })
        .eq('path', child.path)
    }
  }

  res.json({ ok: true, newPath })
}
