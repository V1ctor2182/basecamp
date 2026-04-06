import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './_lib/supabase.js'

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { files } = req.body as { files: { name: string; content: string; dir?: string }[] }
  if (!files || !Array.isArray(files)) return res.status(400).json({ error: 'Missing files array' })

  const results: { path: string; ok: boolean; error?: string }[] = []

  for (const file of files) {
    const fileName = file.name.endsWith('.md') ? file.name : file.name + '.md'
    const filePath = file.dir ? `${file.dir}/${fileName}` : fileName

    // Ensure parent dir exists
    if (file.dir) {
      const parts = file.dir.split('/')
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

    // Upload to storage
    const { error: uploadError } = await supabase.storage
      .from('documents')
      .upload(filePath, file.content, {
        contentType: 'text/markdown',
        upsert: true,
      })

    if (uploadError) {
      results.push({ path: filePath, ok: false, error: uploadError.message })
      continue
    }

    // Insert metadata
    const { error: insertError } = await supabase.from('documents').upsert({
      path: filePath,
      name: fileName,
      parent_path: file.dir || '',
      type: 'file',
    }, { onConflict: 'path' })

    if (insertError) {
      results.push({ path: filePath, ok: false, error: insertError.message })
    } else {
      results.push({ path: filePath, ok: true })
    }
  }

  res.json({ results })
}
