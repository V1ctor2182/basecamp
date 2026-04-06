import { supabase } from './supabase.js'

export async function getGitHubToken(): Promise<string | undefined> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN

  const { data } = await supabase
    .from('config')
    .select('value')
    .eq('key', 'githubToken')
    .single()

  return data?.value || undefined
}

export async function githubFetch(endpoint: string, token?: string) {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'learn-dashboard',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`https://api.github.com${endpoint}`, { headers })
  if (res.status === 409) return [] // empty repo
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}
