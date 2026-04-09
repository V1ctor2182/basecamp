import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './_lib/supabase.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { dir, name } = req.body
  const fileName = name.endsWith('.md') ? name : name + '.md'
  const filePath = dir ? `${dir}/${fileName}` : fileName
  const content = `# ${name.replace('.md', '')}\n\n`

  // Ensure parent dir exists in documents table
  if (dir) {
    const parts = dir.split('/')
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

  // Upload file content to storage
  const { error: uploadError } = await supabase.storage
    .from('documents')
    .upload(filePath, content, { contentType: 'text/markdown' })

  if (uploadError) return res.status(500).json({ error: uploadError.message })

  // Insert metadata
  const { error: insertError } = await supabase.from('documents').insert({
    path: filePath,
    name: fileName,
    parent_path: dir || '',
    type: 'file',
  })

  if (insertError) return res.status(500).json({ error: insertError.message })

  res.json({ path: filePath })
}
