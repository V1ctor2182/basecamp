import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './_lib/supabase.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const filePath = req.query.path as string
    if (!filePath) return res.status(400).json({ error: 'Missing path' })

    const { data, error } = await supabase.storage
      .from('documents')
      .download(filePath)

    if (error) return res.status(500).json({ error: error.message })
    const content = await data.text()
    return res.json({ content })
  }

  if (req.method === 'POST') {
    const { path: filePath, content } = req.body
    if (!filePath || content === undefined) return res.status(400).json({ error: 'Missing path or content' })

    const { error: uploadError } = await supabase.storage
      .from('documents')
      .upload(filePath, content, {
        contentType: 'text/markdown',
        upsert: true,
      })

    if (uploadError) return res.status(500).json({ error: uploadError.message })

    await supabase
      .from('documents')
      .update({ updated_at: new Date().toISOString() })
      .eq('path', filePath)

    return res.json({ ok: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
