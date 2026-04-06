#!/usr/bin/env node
/**
 * Migration script: uploads local learn/ markdown files to Supabase
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/migrate.mjs
 *
 * Optional: GITHUB_TOKEN (will be stored in config table)
 */

import { createClient } from '@supabase/supabase-js'
import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const LEARN_DIR = path.resolve(import.meta.dirname, '..', '..')
const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data')

const SKIP_DIRS = new Set(['.git', 'node_modules', 'learn-dashboard', '.DS_Store'])

async function walkDir(dirPath, relativePath = '') {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const results = []

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      results.push({ path: rel, name: entry.name, parentPath: relativePath, type: 'dir' })
      const children = await walkDir(path.join(dirPath, entry.name), rel)
      results.push(...children)
    } else if (entry.name.endsWith('.md')) {
      results.push({
        path: rel,
        name: entry.name,
        parentPath: relativePath,
        type: 'file',
        fullPath: path.join(dirPath, entry.name),
      })
    }
  }

  return results
}

async function main() {
  console.log(`Scanning learn directory: ${LEARN_DIR}`)
  const items = await walkDir(LEARN_DIR)

  console.log(`Found ${items.length} items (files + dirs)`)

  // 1. Insert document metadata
  let docCount = 0
  for (const item of items) {
    const { error } = await supabase.from('documents').upsert({
      path: item.path,
      name: item.name,
      parent_path: item.parentPath,
      type: item.type,
    }, { onConflict: 'path' })

    if (error) {
      console.error(`  Error inserting ${item.path}:`, error.message)
    } else {
      docCount++
    }
  }
  console.log(`Inserted ${docCount} document metadata rows`)

  // 2. Upload file contents to storage
  let uploadCount = 0
  const files = items.filter(i => i.type === 'file')
  for (const file of files) {
    const content = await fs.readFile(file.fullPath, 'utf-8')
    const { error } = await supabase.storage
      .from('documents')
      .upload(file.path, content, {
        contentType: 'text/markdown',
        upsert: true,
      })

    if (error) {
      console.error(`  Error uploading ${file.path}:`, error.message)
    } else {
      uploadCount++
      process.stdout.write(`\r  Uploaded ${uploadCount}/${files.length}`)
    }
  }
  console.log(`\nUploaded ${uploadCount} files to storage`)

  // 3. Migrate repos.json
  const reposFile = path.join(DATA_DIR, 'repos.json')
  if (existsSync(reposFile)) {
    const repos = JSON.parse(await fs.readFile(reposFile, 'utf-8'))
    if (repos.length > 0) {
      const { error } = await supabase.from('repos').upsert(
        repos.map(r => ({
          id: r.id,
          url: r.url,
          owner: r.owner,
          repo: r.repo,
          added_at: r.addedAt,
        })),
        { onConflict: 'id' }
      )
      if (error) console.error('Error migrating repos:', error.message)
      else console.log(`Migrated ${repos.length} repos`)
    }
  }

  // 4. Migrate config (username only, token goes to env vars)
  const configFile = path.join(DATA_DIR, 'config.json')
  if (existsSync(configFile)) {
    const config = JSON.parse(await fs.readFile(configFile, 'utf-8'))
    if (config.githubUsername) {
      await supabase.from('config').upsert(
        { key: 'githubUsername', value: config.githubUsername },
        { onConflict: 'key' }
      )
      console.log(`Migrated config: githubUsername = ${config.githubUsername}`)
    }
    console.log('NOTE: GitHub token should be set as GITHUB_TOKEN environment variable in Vercel, not stored in the database.')
  }

  console.log('\nMigration complete!')
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
