import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeMirror from '@uiw/react-codemirror'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import mermaid from 'mermaid'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import {
  BookOpen, ChevronRight, FileText, FolderOpen,
  Search, Save, Plus, FolderPlus, Eye, Code2,
  Columns2, Layers, Minus, ZoomIn, ZoomOut, Maximize2,
  Moon, Sun, Pencil, Trash2, FolderInput, PanelLeftClose, PanelLeftOpen,
  Activity, Upload, HardDrive, X, Briefcase
} from 'lucide-react'
import { Link } from 'react-router-dom'
import './learn.css'

// Slug & TOC helpers
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
}

function textContent(node: React.ReactNode): string {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (typeof node === 'object' && 'props' in node) return textContent((node as any).props.children)
  return ''
}

interface TocItem { level: number; text: string; id: string }

function extractToc(md: string): TocItem[] {
  const cleaned = md.replace(/```[\s\S]*?```/g, '')
  const items: TocItem[] = []
  const regex = /^(#{1,4})\s+(.+)$/gm
  let match
  while ((match = regex.exec(cleaned)) !== null) {
    const text = match[2].trim()
    items.push({ level: match[1].length, text, id: slugify(text) })
  }
  return items
}

function findHeadingLine(md: string, headingId: string): number {
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^#{1,4}\s+(.+)$/)
    if (match && slugify(match[1].trim()) === headingId) return i + 1
  }
  return 1
}

// Types
interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

// Mermaid init
mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  themeVariables: {
    background: 'transparent',
    primaryColor: '#E8F0E6',
    primaryTextColor: '#2D2B28',
    primaryBorderColor: '#2D5A27',
    lineColor: '#8C8C8C',
    secondaryColor: '#F0EBE2',
    tertiaryColor: '#FAF7F2',
    mainBkg: '#FAF7F2',
    fontFamily: 'Space Grotesk, sans-serif',
  }
})

// Interactive Mermaid diagram
function MermaidDiagram({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [highlightedNode, setHighlightedNode] = useState<string | null>(null)

  useEffect(() => {
    if (!ref.current) return
    ref.current.innerHTML = ''
    mermaid.render(`mermaid-${Math.random().toString(36).slice(2)}`, code).then(({ svg }) => {
      if (!ref.current) return
      ref.current.innerHTML = svg

      // Attach hover/click interactivity to nodes
      const nodes = ref.current.querySelectorAll('.node')
      nodes.forEach(node => {
        const el = node as HTMLElement
        el.style.cursor = 'pointer'
        el.style.transition = 'filter 150ms ease'

        el.addEventListener('mouseenter', (e) => {
          const label = el.querySelector('.nodeLabel')?.textContent || ''
          if (label) {
            const rect = el.getBoundingClientRect()
            const container = ref.current!.closest('.mermaid-container')!.getBoundingClientRect()
            setTooltip({ text: label, x: rect.left - container.left + rect.width / 2, y: rect.top - container.top - 8 })
          }
          el.style.filter = 'brightness(0.9)'
        })

        el.addEventListener('mouseleave', () => {
          setTooltip(null)
          el.style.filter = ''
        })

        el.addEventListener('click', () => {
          const nodeId = el.id
          setHighlightedNode(prev => prev === nodeId ? null : nodeId)
        })
      })
    }).catch(() => {
      if (ref.current) ref.current.textContent = code
    })
  }, [code])

  // Apply highlight styles when highlightedNode changes
  useEffect(() => {
    if (!ref.current) return
    // Reset all
    ref.current.querySelectorAll('.node').forEach(n => {
      (n as HTMLElement).classList.remove('mermaid-node-highlight', 'mermaid-node-dimmed')
    })
    ref.current.querySelectorAll('.edgePath').forEach(e => {
      (e as HTMLElement).classList.remove('mermaid-edge-highlight', 'mermaid-edge-dimmed')
    })

    if (!highlightedNode) return

    // Find connected edges and nodes
    const connectedNodes = new Set<string>([highlightedNode])
    ref.current.querySelectorAll('.edgePath').forEach(edge => {
      const id = edge.id || ''
      if (id.includes(highlightedNode)) {
        (edge as HTMLElement).classList.add('mermaid-edge-highlight')
        // Extract connected node IDs from edge ID (format: L-NodeA-NodeB)
        const parts = id.replace(/^L-/, '').split('-')
        parts.forEach(p => { if (p) connectedNodes.add(p) })
      } else {
        (edge as HTMLElement).classList.add('mermaid-edge-dimmed')
      }
    })

    ref.current.querySelectorAll('.node').forEach(node => {
      if (connectedNodes.has(node.id)) {
        (node as HTMLElement).classList.add('mermaid-node-highlight')
      } else {
        (node as HTMLElement).classList.add('mermaid-node-dimmed')
      }
    })
  }, [highlightedNode])

  return (
    <div>
      <div className="diagram-label">Diagram · scroll to zoom · drag to pan · click node to highlight</div>
      <div className="mermaid-container">
        <TransformWrapper
          initialScale={1}
          minScale={0.4}
          maxScale={3}
          centerOnInit
          wheel={{ step: 0.08 }}
        >
          {({ zoomIn, zoomOut, resetTransform }) => (
            <>
              <div className="mermaid-controls">
                <button onClick={() => zoomIn()} title="Zoom in"><ZoomIn size={14} /></button>
                <button onClick={() => zoomOut()} title="Zoom out"><ZoomOut size={14} /></button>
                <button onClick={() => { resetTransform(); setHighlightedNode(null) }} title="Reset"><Maximize2 size={14} /></button>
              </div>
              <TransformComponent wrapperStyle={{ width: '100%' }} contentStyle={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
                <div ref={ref} />
              </TransformComponent>
            </>
          )}
        </TransformWrapper>
        {tooltip && (
          <div className="mermaid-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
            {tooltip.text}
          </div>
        )}
      </div>
    </div>
  )
}

// Code block router
function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const text = String(children).replace(/\n$/, '')
  const lang = className?.replace('language-', '') || ''

  if (lang === 'mermaid') {
    return <MermaidDiagram code={text} />
  }

  return <code className={className}>{children}</code>
}

interface LearnDir {
  id: string
  name: string
  path: string
}

// API helpers
const api = {
  tree: () => fetch('/api/tree').then(r => r.json()),
  learnDirs: () => fetch('/api/learn-dirs').then(r => r.json()) as Promise<LearnDir[]>,
  addLearnDir: (name: string, path: string) =>
    fetch('/api/learn-dirs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path })
    }).then(r => r.json()),
  removeLearnDir: (id: string) =>
    fetch(`/api/learn-dirs/${id}`, { method: 'DELETE' }).then(r => r.json()),
  read: (path: string) => fetch(`/api/file?path=${encodeURIComponent(path)}`).then(r => r.json()),
  write: (path: string, content: string) =>
    fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content })
    }).then(r => r.json()),
  newFile: (dir: string, name: string) =>
    fetch('/api/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, name })
    }).then(r => r.json()),
  newFolder: (path: string) =>
    fetch('/api/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    }).then(r => r.json()),
  rename: (path: string, newName: string) =>
    fetch('/api/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, newName })
    }).then(r => r.json()),
  del: (path: string) =>
    fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    }).then(r => r.json()),
  move: (from: string, to: string) =>
    fetch('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to })
    }).then(r => r.json()),
  upload: (files: { name: string; content: string; dir?: string }[]) =>
    fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files })
    }).then(r => r.json()),
}

function LearnApp() {
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('learn-sidebar') !== 'closed')
  const [tree, setTree] = useState<TreeNode[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [view, setView] = useState<'preview' | 'edit' | 'split'>('preview')
  const [toast, setToast] = useState('')
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState<null | 'file' | 'folder'>(null)
  const [modalInput, setModalInput] = useState('')
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('learn-open-folders')
    return saved ? new Set(JSON.parse(saved) as string[]) : new Set<string>()
  })
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('learn-font-size')
    return saved ? Number(saved) : 16
  })
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('learn-theme') === 'dark')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null)
  const [renameModal, setRenameModal] = useState<TreeNode | null>(null)
  const [deleteModal, setDeleteModal] = useState<TreeNode | null>(null)
  const [moveModal, setMoveModal] = useState<TreeNode | null>(null)
  const [renameInput, setRenameInput] = useState('')
  const [moveTarget, setMoveTarget] = useState('')
  const [uploading, setUploading] = useState(false)
  const [learnDirs, setLearnDirs] = useState<LearnDir[]>([])
  const [showDirManager, setShowDirManager] = useState(false)
  const [newDirName, setNewDirName] = useState('')
  const [newDirPath, setNewDirPath] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [activeHeading, setActiveHeading] = useState<string | null>(null)
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const toc = useMemo(() => extractToc(content), [content])

  // Switch view with scroll sync (preview → edit)
  const switchView = useCallback((newView: 'preview' | 'edit' | 'split') => {
    const wasPreview = view === 'preview'
    setView(newView)
    if (wasPreview && (newView === 'edit' || newView === 'split') && activeHeading) {
      const headingId = activeHeading
      setTimeout(() => {
        const ev = editorRef.current?.view
        if (!ev) return
        const lineNum = findHeadingLine(content, headingId)
        if (lineNum > 0) {
          const pos = ev.state.doc.line(lineNum).from
          ev.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 20 }) })
        }
      }, 50)
    }
  }, [view, activeHeading, content])

  // TOC click handler
  const handleTocClick = useCallback((id: string) => {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (view === 'edit' || view === 'split') {
      const ev = editorRef.current?.view
      if (ev) {
        const lineNum = findHeadingLine(content, id)
        if (lineNum > 0) {
          const pos = ev.state.doc.line(lineNum).from
          ev.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 20 }) })
        }
      }
    }
  }, [view, content])

  // Synchronous: children see correct data-theme (and CSS vars) during their render.
  document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')

  useEffect(() => {
    localStorage.setItem('learn-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  const isDirty = content !== savedContent

  const adjustFontSize = (delta: number) => {
    setFontSize(prev => {
      const next = Math.min(22, Math.max(13, prev + delta))
      localStorage.setItem('learn-font-size', String(next))
      return next
    })
  }

  // Load tree
  const loadTree = useCallback(async () => {
    const [data, dirs] = await Promise.all([api.tree(), api.learnDirs()])
    setTree(data)
    setLearnDirs(dirs)
    // Only auto-expand all on first visit (no saved state)
    if (!localStorage.getItem('learn-open-folders')) {
      const allPaths = new Set<string>()
      function walk(nodes: TreeNode[]) {
        for (const n of nodes) {
          if (n.type === 'dir') { allPaths.add(n.path); if (n.children) walk(n.children) }
        }
      }
      walk(data)
      setOpenFolders(allPaths)
    }
  }, [])

  useEffect(() => { loadTree() }, [loadTree])

  // Open file
  const openFile = useCallback(async (path: string) => {
    const data = await api.read(path)
    setActiveFile(path)
    setContent(data.content)
    setSavedContent(data.content)
  }, [])

  // Save
  const save = useCallback(async () => {
    if (!activeFile) return
    await api.write(activeFile, content)
    setSavedContent(content)
    showToast('Saved')
  }, [activeFile, content])

  // Keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save])

  // Toast
  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2000)
  }

  // Create file/folder
  const handleCreate = async () => {
    if (!modalInput.trim()) return
    if (modal === 'file') {
      const result = await api.newFile('', modalInput)
      await loadTree()
      openFile(result.path)
    } else {
      await api.newFolder(modalInput)
      await loadTree()
    }
    setModal(null)
    setModalInput('')
  }

  // Upload handler
  const handleUpload = useCallback(async (fileList: FileList) => {
    setUploading(true)
    try {
      const files: { name: string; content: string }[] = []
      for (const file of Array.from(fileList)) {
        const content = await file.text()
        files.push({ name: file.name, content })
      }
      await api.upload(files)
      await loadTree()
      showToast(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}`)
    } catch (err) {
      showToast('Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [loadTree])

  // Drag and drop handler
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const files = e.dataTransfer.files
    if (files.length > 0) handleUpload(files)
  }, [handleUpload])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  // Context menu handler
  const handleContextMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, node })
  }, [])

  // Dismiss context menu on click or escape
  useEffect(() => {
    if (!contextMenu) return
    const dismiss = () => setContextMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
    window.addEventListener('click', dismiss)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('click', dismiss); window.removeEventListener('keydown', onKey) }
  }, [contextMenu])

  // Rename
  const handleRename = async () => {
    if (!renameModal || !renameInput.trim()) return
    const result = await api.rename(renameModal.path, renameInput)
    if (result.ok) {
      if (activeFile === renameModal.path) setActiveFile(result.newPath)
      else if (activeFile?.startsWith(renameModal.path + '/')) {
        setActiveFile(activeFile.replace(renameModal.path, result.newPath))
      }
      await loadTree()
      showToast('Renamed')
    }
    setRenameModal(null)
  }

  // Delete
  const handleDelete = async () => {
    if (!deleteModal) return
    const result = await api.del(deleteModal.path)
    if (result.ok) {
      if (activeFile === deleteModal.path || activeFile?.startsWith(deleteModal.path + '/')) {
        setActiveFile(null)
        setContent('')
        setSavedContent('')
      }
      await loadTree()
      showToast('Deleted')
    }
    setDeleteModal(null)
  }

  // Move
  const handleMove = async () => {
    if (!moveModal) return
    const result = await api.move(moveModal.path, moveTarget)
    if (result.ok) {
      if (activeFile === moveModal.path) setActiveFile(result.newPath)
      else if (activeFile?.startsWith(moveModal.path + '/')) {
        setActiveFile(activeFile.replace(moveModal.path, result.newPath))
      }
      await loadTree()
      showToast('Moved')
    }
    setMoveModal(null)
    setMoveTarget('')
  }

  // Collect all folder paths for the move picker
  const collectFolders = (nodes: TreeNode[]): { name: string; path: string; depth: number }[] => {
    const result: { name: string; path: string; depth: number }[] = [{ name: '/ (root)', path: '', depth: 0 }]
    function walk(items: TreeNode[], depth: number) {
      for (const n of items) {
        if (n.type === 'dir') {
          result.push({ name: n.name, path: n.path, depth })
          if (n.children) walk(n.children, depth + 1)
        }
      }
    }
    walk(nodes, 1)
    return result
  }

  // Filter tree
  const filterTree = (nodes: TreeNode[], query: string): TreeNode[] => {
    if (!query) return nodes
    return nodes.reduce<TreeNode[]>((acc, node) => {
      if (node.type === 'file' && node.name.toLowerCase().includes(query.toLowerCase())) {
        acc.push(node)
      } else if (node.type === 'dir' && node.children) {
        const filtered = filterTree(node.children, query)
        if (filtered.length > 0) acc.push({ ...node, children: filtered })
      }
      return acc
    }, [])
  }

  const toggleFolder = (path: string) => {
    setOpenFolders(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      localStorage.setItem('learn-open-folders', JSON.stringify([...next]))
      return next
    })
  }

  const displayTree = filterTree(tree, search)

  const fileName = activeFile?.split('/').pop() || ''

  const toggleSidebar = () => {
    setSidebarOpen(prev => {
      localStorage.setItem('learn-sidebar', prev ? 'closed' : 'open')
      return !prev
    })
  }

  return (
    <div className={`app-layout ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      {/* Sidebar */}
      <div className="sidebar">
        {sidebarOpen ? (
          <>
            <div className="sidebar-header">
              <div className="sidebar-logo">
                <Layers size={22} strokeWidth={1.8} />
                Learn
              </div>
              <div className="sidebar-subtitle">Knowledge Base</div>
              <button className="sidebar-collapse-btn" onClick={toggleSidebar} title="Collapse sidebar">
                <PanelLeftClose size={16} />
              </button>
            </div>

            <div className="search-box">
              <div className="search-wrapper">
                <Search />
                <input
                  className="search-input"
                  placeholder="Search files…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="sidebar-actions">
              <button className="btn-action" onClick={() => { setModal('file'); setModalInput('') }}>
                <Plus size={14} /> File
              </button>
              <button className="btn-action" onClick={() => { setModal('folder'); setModalInput('') }}>
                <FolderPlus size={14} /> Folder
              </button>
              <button className="btn-action" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                <Upload size={14} /> {uploading ? 'Uploading…' : 'Upload'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.txt"
                multiple
                style={{ display: 'none' }}
                onChange={e => e.target.files && handleUpload(e.target.files)}
              />
            </div>

            <Link to="/tracker" className="sidebar-tracker-link">
              <Activity size={15} />
              <span>Work Tracker</span>
            </Link>

            <Link to="/career" className="sidebar-tracker-link">
              <Briefcase size={15} />
              <span>Career</span>
            </Link>

            <div className="sidebar-dirs">
              <button className="sidebar-dirs-toggle" onClick={() => setShowDirManager(!showDirManager)}>
                <HardDrive size={14} />
                <span>{learnDirs.length} folder{learnDirs.length !== 1 ? 's' : ''}</span>
              </button>
              {showDirManager && (
                <div className="dir-manager">
                  {learnDirs.map(d => (
                    <div key={d.id} className="dir-item">
                      <FolderOpen size={13} />
                      <div className="dir-item-info">
                        <span className="dir-item-name">{d.name}</span>
                        <span className="dir-item-path">{d.path}</span>
                      </div>
                      <button
                        className="dir-item-remove"
                        onClick={async () => {
                          await api.removeLearnDir(d.id)
                          loadTree()
                          showToast(`Removed ${d.name}`)
                        }}
                        title="Remove"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <div className="dir-add-form">
                    <button
                      className="btn-action dir-browse-btn"
                      onClick={async () => {
                        try {
                          const res = await fetch('/api/pick-folder', { method: 'POST' })
                          const r = await res.json()
                          if (r.cancelled) return
                          if (r.error) { showToast(r.error); return }
                          setNewDirPath(r.path)
                          if (!newDirName.trim()) setNewDirName(r.name)
                        } catch { showToast('Failed to open folder picker') }
                      }}
                    >
                      <FolderPlus size={12} /> Browse…
                    </button>
                    <input
                      placeholder="Name"
                      value={newDirName}
                      onChange={e => setNewDirName(e.target.value)}
                      className="dir-add-input"
                    />
                    <input
                      placeholder="~/path/to/folder"
                      value={newDirPath}
                      onChange={e => setNewDirPath(e.target.value)}
                      className="dir-add-input"
                      onKeyDown={async e => {
                        if (e.key === 'Enter' && newDirName.trim() && newDirPath.trim()) {
                          try {
                            const res = await fetch('/api/learn-dirs', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ name: newDirName.trim(), path: newDirPath.trim() })
                            })
                            const r = await res.json()
                            if (!res.ok || r.error) {
                              showToast(r.error || 'Failed to add folder')
                            } else {
                              setNewDirName(''); setNewDirPath(''); await loadTree(); showToast('Folder added')
                            }
                          } catch { showToast('Failed to add folder') }
                        }
                      }}
                    />
                    <button
                      className="btn-action dir-add-btn"
                      disabled={!newDirName.trim() || !newDirPath.trim()}
                      onClick={async () => {
                        try {
                          const res = await fetch('/api/learn-dirs', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: newDirName.trim(), path: newDirPath.trim() })
                          })
                          const r = await res.json()
                          if (!res.ok || r.error) {
                            showToast(r.error || 'Failed to add folder')
                          } else {
                            setNewDirName(''); setNewDirPath(''); await loadTree(); showToast('Folder added')
                          }
                        } catch (e) {
                          showToast('Failed to add folder')
                        }
                      }}
                    >
                      <Plus size={12} /> Add
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="sidebar-tree" onDrop={handleDrop} onDragOver={handleDragOver}>
              {displayTree.map(node => (
                <TreeItem
                  key={node.path}
                  node={node}
                  activeFile={activeFile}
                  openFolders={openFolders}
                  toggleFolder={toggleFolder}
                  onSelect={openFile}
                  onContextMenu={handleContextMenu}
                  depth={0}
                />
              ))}
            </div>
          </>
        ) : (
          <button className="sidebar-expand-btn" onClick={toggleSidebar} title="Expand sidebar">
            <PanelLeftOpen size={16} />
          </button>
        )}
      </div>

      {/* Main */}
      <div className="main-content">
        {activeFile ? (
          <>
            <div className="tab-bar">
              <button className={`tab ${view === 'preview' ? 'active' : ''}`} onClick={() => switchView('preview')}>
                <Eye size={14} /> Preview
              </button>
              <button className={`tab ${view === 'edit' ? 'active' : ''}`} onClick={() => switchView('edit')}>
                <Code2 size={14} /> Edit
              </button>
              <button className={`tab ${view === 'split' ? 'active' : ''}`} onClick={() => switchView('split')}>
                <Columns2 size={14} /> Split
              </button>
              <div className="tab-spacer" />
              <button
                className="theme-toggle"
                onClick={() => setDarkMode(d => !d)}
                title={darkMode ? 'Switch to light mode' : 'Switch to night mode'}
              >
                {darkMode ? <Sun size={14} /> : <Moon size={14} />}
              </button>
              <div className="font-size-controls">
                <button onClick={() => adjustFontSize(-1)} title="Decrease font size">
                  <Minus size={12} />
                </button>
                <span className="font-size-label">{fontSize}px</span>
                <button onClick={() => adjustFontSize(1)} title="Increase font size">
                  <Plus size={12} />
                </button>
              </div>
              {isDirty && (
                <button className="btn-save" onClick={save}>
                  <Save size={13} /> Save
                </button>
              )}
            </div>

            <div className={`editor-container view-${view}`} style={{ '--font-size-base': `${fontSize}px` } as React.CSSProperties}>
              <div className="editor-pane pane-editor">
                <CodeMirror
                  ref={editorRef}
                  value={content}
                  onChange={setContent}
                  extensions={[markdown()]}
                  theme={darkMode ? 'dark' : 'light'}
                  basicSetup={{
                    lineNumbers: true,
                    highlightActiveLine: true,
                    foldGutter: true,
                  }}
                />
              </div>
              <div className="editor-pane pane-preview">
                <MarkdownPreview content={content} filePath={activeFile} onActiveHeading={setActiveHeading} />
                {toc.length > 1 && (
                  <div className="toc-float">
                    <TableOfContents items={toc} activeId={activeHeading} onItemClick={handleTocClick} />
                  </div>
                )}
              </div>
            </div>

            <div className="status-bar">
              <span><span className="status-dot" /> {fileName}{isDirty ? ' · Modified' : ''}</span>
              <span>{content.split('\n').length} lines · {content.length} chars</span>
            </div>
          </>
        ) : (
          <div className="welcome">
            <BookOpen strokeWidth={1} />
            <div className="welcome-title">Select a document to begin</div>
            <div className="welcome-sub">Browse topics in the sidebar or create a new file</div>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}

      {/* Modal */}
      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{modal === 'file' ? 'New Document' : 'New Topic Folder'}</h3>
            <input
              autoFocus
              placeholder={modal === 'file' ? 'document-name.md' : 'topic-name'}
              value={modalInput}
              onChange={e => setModalInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
            />
            <div className="modal-actions">
              <button className="btn-modal" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn-modal primary" onClick={handleCreate}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <button className="context-menu-item" onClick={() => {
            setRenameInput(contextMenu.node.name)
            setRenameModal(contextMenu.node)
            setContextMenu(null)
          }}>
            <Pencil size={14} /> Rename
          </button>
          <button className="context-menu-item" onClick={() => {
            setMoveTarget('')
            setMoveModal(contextMenu.node)
            setContextMenu(null)
          }}>
            <FolderInput size={14} /> Move to…
          </button>
          <div className="context-menu-separator" />
          <button className="context-menu-item danger" onClick={() => {
            setDeleteModal(contextMenu.node)
            setContextMenu(null)
          }}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}

      {/* Rename modal */}
      {renameModal && (
        <div className="modal-overlay" onClick={() => setRenameModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Rename</h3>
            <input
              autoFocus
              value={renameInput}
              onChange={e => setRenameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleRename()}
            />
            <div className="modal-actions">
              <button className="btn-modal" onClick={() => setRenameModal(null)}>Cancel</button>
              <button className="btn-modal primary" onClick={handleRename}>Rename</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete modal */}
      {deleteModal && (
        <div className="modal-overlay" onClick={() => setDeleteModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Delete {deleteModal.type === 'dir' ? 'folder' : 'file'}</h3>
            <p className="modal-warning">
              Are you sure you want to delete <strong>{deleteModal.name}</strong>?
              {deleteModal.type === 'dir' && ' This will delete all contents inside.'}
              {' '}This cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="btn-modal" onClick={() => setDeleteModal(null)}>Cancel</button>
              <button className="btn-modal danger" onClick={handleDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Move modal */}
      {moveModal && (
        <div className="modal-overlay" onClick={() => setMoveModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Move "{moveModal.name}" to…</h3>
            <div className="move-folder-list">
              {collectFolders(tree)
                .filter(f => f.path !== moveModal.path && !f.path.startsWith(moveModal.path + '/'))
                .map(f => (
                  <button
                    key={f.path}
                    className={`move-folder-item ${moveTarget === f.path ? 'selected' : ''}`}
                    style={{ paddingLeft: 12 + f.depth * 16 }}
                    onClick={() => setMoveTarget(f.path)}
                  >
                    <FolderOpen size={14} /> {f.name}
                  </button>
                ))}
            </div>
            <div className="modal-actions">
              <button className="btn-modal" onClick={() => setMoveModal(null)}>Cancel</button>
              <button className="btn-modal primary" onClick={handleMove}>Move</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Tree item component
function TreeItem({
  node, activeFile, openFolders, toggleFolder, onSelect, onContextMenu, depth
}: {
  node: TreeNode
  activeFile: string | null
  openFolders: Set<string>
  toggleFolder: (path: string) => void
  onSelect: (path: string) => void
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void
  depth: number
}) {
  if (node.type === 'dir') {
    const isOpen = openFolders.has(node.path)
    return (
      <div className="tree-folder">
        <div
          className={`tree-folder-header ${isOpen ? 'open' : ''}`}
          style={{ paddingLeft: 16 + depth * 12 }}
          onClick={() => toggleFolder(node.path)}
          onContextMenu={e => onContextMenu(e, node)}
        >
          <ChevronRight size={14} />
          <FolderOpen size={14} />
          {node.name}
        </div>
        {isOpen && node.children && (
          <div className="tree-folder-children">
            {node.children.map(child => (
              <TreeItem
                key={child.path}
                node={child}
                activeFile={activeFile}
                openFolders={openFolders}
                toggleFolder={toggleFolder}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={`tree-file ${activeFile === node.path ? 'active' : ''}`}
      style={{ paddingLeft: 24 + depth * 12 }}
      onClick={() => onSelect(node.path)}
      onContextMenu={e => onContextMenu(e, node)}
    >
      <FileText size={15} />
      <span className="tree-file-name">{node.name.replace('.md', '')}</span>
    </div>
  )
}

// Markdown Preview component
function MarkdownPreview({ content, filePath, onActiveHeading }: {
  content: string; filePath: string; onActiveHeading?: (id: string | null) => void
}) {
  const previewRef = useRef<HTMLDivElement>(null)

  // Track visible heading via scroll position
  useEffect(() => {
    const container = previewRef.current?.closest('.pane-preview') as HTMLElement
    if (!container || !onActiveHeading) return

    const handleScroll = () => {
      const headings = previewRef.current?.querySelectorAll('h1[id], h2[id], h3[id], h4[id]')
      if (!headings) return
      const containerTop = container.getBoundingClientRect().top
      let active: string | null = null
      for (const h of headings) {
        if (h.getBoundingClientRect().top - containerTop <= 100) active = h.id
      }
      onActiveHeading(active)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()
    return () => container.removeEventListener('scroll', handleScroll)
  }, [content, onActiveHeading])

  // Heading component with auto-generated id
  const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4') =>
    ({ children, ...props }: any) => <Tag id={slugify(textContent(children))} {...props}>{children}</Tag>

  const markdownContent = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: heading('h1'),
        h2: heading('h2'),
        h3: heading('h3'),
        h4: heading('h4'),
        code({ className, children, ...props }) {
          const isInline = !className
          if (isInline) return <code {...props}>{children}</code>
          return <CodeBlock className={className}>{children}</CodeBlock>
        },
        pre({ children }) {
          return <pre>{children}</pre>
        }
      }}
    >
      {content}
    </ReactMarkdown>
  )

  return (
    <div className="markdown-preview" ref={previewRef}>
      <div className="breadcrumb">
        {filePath}
      </div>
      {markdownContent}
    </div>
  )
}

// Table of Contents component
function TableOfContents({ items, activeId, onItemClick }: {
  items: TocItem[]
  activeId: string | null
  onItemClick: (id: string) => void
}) {
  return (
    <nav className="toc-nav">
      {/* Ruler ticks — always visible */}
      <div className="toc-ruler">
        {items.map((item, i) => (
          <div
            key={`${item.id}-${i}`}
            className={`toc-ruler-tick${activeId === item.id ? ' active' : ''}`}
            onClick={() => onItemClick(item.id)}
          >
            <span
              className="toc-ruler-line"
              style={{ width: item.level === 1 ? '100%' : item.level === 2 ? '70%' : item.level === 3 ? '45%' : '28%' }}
            />
          </div>
        ))}
      </div>
      {/* Full panel — appears on hover */}
      <div className="toc-panel">
        <div className="toc-panel-title">On this page</div>
        {items.map((item, i) => (
          <button
            key={`${item.id}-${i}`}
            className={`toc-item toc-level-${item.level} ${activeId === item.id ? 'active' : ''}`}
            onClick={() => onItemClick(item.id)}
            title={item.text}
          >
            {item.text}
          </button>
        ))}
      </div>
    </nav>
  )
}

export default LearnApp
