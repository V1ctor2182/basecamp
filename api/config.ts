import type { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './_lib/supabase.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const { data } = await supabase
      .from('config')
      .select('key, value')

    const config: Record<string, string> = {}
    for (const row of data || []) config[row.key] = row.value

    return res.json({
      githubUsername: config.githubUsername || '',
      hasToken: !!(process.env.GITHUB_TOKEN || config.githubToken),
    })
  }

  if (req.method === 'PUT') {
    const { githubUsername, githubToken } = req.body

    if (githubUsername !== undefined) {
      await supabase.from('config').upsert({ key: 'githubUsername', value: githubUsername }, { onConflict: 'key' })
    }
    if (githubToken) {
      await supabase.from('config').upsert({ key: 'githubToken', value: githubToken }, { onConflict: 'key' })
    }

    return res.json({ ok: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
