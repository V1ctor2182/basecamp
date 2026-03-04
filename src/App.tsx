import { useState, useEffect, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import mermaid from 'mermaid'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import {
  BookOpen, ChevronRight, FileText, FolderOpen,
  Search, Save, Plus, FolderPlus, Eye, Code2,
  Columns2, Layers, Minus, ZoomIn, ZoomOut, Maximize2
} from 'lucide-react'
import './index.css'

// Types
interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

interface EnhancerModule {
  default?: React.ComponentType<{ children: React.ReactNode }>
  widgets?: Record<string, React.FC>
}

// Discover companion .tsx files in learn/topic-folder/ (one level deep)
const enhancerModules = import.meta.glob<EnhancerModule>(
  '../../**/*.tsx',
  { eager: false }
)

// Load enhancer for a given MD file path
function useEnhancer(filePath: string) {
  const [enhancer, setEnhancer] = useState<EnhancerModule | null>(null)

  useEffect(() => {
    const enhancerPath = `../../${filePath.replace(/\.md$/, '.tsx')}`
    const loader = enhancerModules[enhancerPath]

    if (!loader) {
      setEnhancer(null)
      return
    }

    loader().then(mod => setEnhancer(mod)).catch(() => setEnhancer(null))
  }, [filePath])

  return enhancer
}

// Widget skeleton shown while enhancer is loading or widget not found
function WidgetSkeleton({ name }: { name: string }) {
  return (
    <div className="widget-skeleton">
      <div className="widget-skeleton-shimmer" />
      <span className="widget-skeleton-label">{name}</span>
    </div>
  )
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

// API helpers
const api = {
  tree: () => fetch('/api/tree').then(r => r.json()),
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
}

function App() {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [view, setView] = useState<'preview' | 'edit' | 'split'>('preview')
  const [toast, setToast] = useState('')
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState<null | 'file' | 'folder'>(null)
  const [modalInput, setModalInput] = useState('')
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('learn-font-size')
    return saved ? Number(saved) : 16
  })

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
    const data = await api.tree()
    setTree(data)
    // Auto-expand all
    const allPaths = new Set<string>()
    function walk(nodes: TreeNode[]) {
      for (const n of nodes) {
        if (n.type === 'dir') { allPaths.add(n.path); if (n.children) walk(n.children) }
      }
    }
    walk(data)
    setOpenFolders(allPaths)
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
      return next
    })
  }

  const displayTree = filterTree(tree, search)

  const fileName = activeFile?.split('/').pop() || ''

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <Layers size={22} strokeWidth={1.8} />
            Learn
          </div>
          <div className="sidebar-subtitle">Knowledge Base</div>
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
        </div>

        <div className="sidebar-tree">
          {displayTree.map(node => (
            <TreeItem
              key={node.path}
              node={node}
              activeFile={activeFile}
              openFolders={openFolders}
              toggleFolder={toggleFolder}
              onSelect={openFile}
              depth={0}
            />
          ))}
        </div>
      </div>

      {/* Main */}
      <div className="main-content">
        {activeFile ? (
          <>
            <div className="tab-bar">
              <button className={`tab ${view === 'preview' ? 'active' : ''}`} onClick={() => setView('preview')}>
                <Eye size={14} /> Preview
              </button>
              <button className={`tab ${view === 'edit' ? 'active' : ''}`} onClick={() => setView('edit')}>
                <Code2 size={14} /> Edit
              </button>
              <button className={`tab ${view === 'split' ? 'active' : ''}`} onClick={() => setView('split')}>
                <Columns2 size={14} /> Split
              </button>
              <div className="tab-spacer" />
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
                  value={content}
                  onChange={setContent}
                  extensions={[markdown()]}
                  theme="light"
                  basicSetup={{
                    lineNumbers: true,
                    highlightActiveLine: true,
                    foldGutter: true,
                  }}
                />
              </div>
              <div className="editor-pane pane-preview">
                <MarkdownPreview content={content} filePath={activeFile} />
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
    </div>
  )
}

// Tree item component
function TreeItem({
  node, activeFile, openFolders, toggleFolder, onSelect, depth
}: {
  node: TreeNode
  activeFile: string | null
  openFolders: Set<string>
  toggleFolder: (path: string) => void
  onSelect: (path: string) => void
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
    >
      <FileText size={15} />
      <span className="tree-file-name">{node.name.replace('.md', '')}</span>
    </div>
  )
}

// Markdown Preview component
function MarkdownPreview({ content, filePath }: { content: string; filePath: string }) {
  const enhancer = useEnhancer(filePath)
  const Wrapper = enhancer?.default
  const widgets = enhancer?.widgets

  const markdownContent = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const isInline = !className
          if (isInline) return <code {...props}>{children}</code>

          const lang = className?.replace('language-', '') || ''

          // Widget routing: ```widget:chart-name```
          if (lang.startsWith('widget:')) {
            const widgetName = lang.replace('widget:', '')
            const Widget = widgets?.[widgetName]
            return Widget ? (
              <div className="widget-container">
                <Widget />
              </div>
            ) : (
              <WidgetSkeleton name={widgetName} />
            )
          }

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
    <div className="markdown-preview">
      <div className="breadcrumb">
        {filePath}
        {enhancer && <span className="breadcrumb-enhanced">Enhanced</span>}
      </div>
      {Wrapper ? <Wrapper>{markdownContent}</Wrapper> : markdownContent}
    </div>
  )
}

export default App
