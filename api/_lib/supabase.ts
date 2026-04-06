import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

export interface DocumentRow {
  id: string
  path: string
  name: string
  parent_path: string
  type: 'file' | 'dir'
  created_at: string
  updated_at: string
}

export interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

export function buildTree(rows: DocumentRow[]): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>()
  const roots: TreeNode[] = []

  // Sort so parents come before children
  rows.sort((a, b) => a.path.localeCompare(b.path))

  for (const row of rows) {
    const node: TreeNode = {
      name: row.name,
      path: row.path,
      type: row.type,
      ...(row.type === 'dir' ? { children: [] } : {}),
    }
    nodeMap.set(row.path, node)

    if (!row.parent_path) {
      roots.push(node)
    } else {
      const parent = nodeMap.get(row.parent_path)
      if (parent && parent.children) {
        parent.children.push(node)
      } else {
        // Parent not found (orphan) — add to root
        roots.push(node)
      }
    }
  }

  return roots
}
