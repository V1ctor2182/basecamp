import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Resolve to the parent directory of wherever server.mjs lives
const LEARN_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Get file tree
app.get('/api/tree', async (req, res) => {
  try {
    const tree = await buildTree(LEARN_DIR, '');
    res.json(tree);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function buildTree(dirPath, relativePath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const children = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'learn-dashboard') continue;
    const rel = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      const sub = await buildTree(path.join(dirPath, entry.name), rel);
      children.push({ name: entry.name, path: rel, type: 'dir', children: sub });
    } else if (entry.name.endsWith('.md')) {
      children.push({ name: entry.name, path: rel, type: 'file' });
    }
  }
  return children;
}

// Read file
app.get('/api/file', async (req, res) => {
  try {
    const filePath = path.join(LEARN_DIR, req.query.path);
    const content = await fs.readFile(filePath, 'utf-8');
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Write file
app.post('/api/file', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    const fullPath = path.join(LEARN_DIR, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create new file
app.post('/api/new', async (req, res) => {
  try {
    const { dir, name } = req.body;
    const fullPath = path.join(LEARN_DIR, dir || '', name.endsWith('.md') ? name : name + '.md');
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, `# ${name.replace('.md', '')}\n\n`, 'utf-8');
    res.json({ path: path.relative(LEARN_DIR, fullPath) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create new folder
app.post('/api/folder', async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    await fs.mkdir(path.join(LEARN_DIR, dirPath), { recursive: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rename file or folder
app.post('/api/rename', async (req, res) => {
  try {
    const { path: itemPath, newName } = req.body;
    const fullPath = path.join(LEARN_DIR, itemPath);
    const newFullPath = path.join(path.dirname(fullPath), newName);
    if (!newFullPath.startsWith(LEARN_DIR)) return res.status(400).json({ error: 'Invalid path' });
    try { await fs.access(newFullPath); return res.status(409).json({ error: 'Name already exists' }); } catch {}
    await fs.rename(fullPath, newFullPath);
    // Also rename companion .tsx if renaming a .md file
    if (fullPath.endsWith('.md')) {
      const tsxOld = fullPath.replace(/\.md$/, '.tsx');
      const tsxNew = newFullPath.replace(/\.md$/, '.tsx');
      try { await fs.access(tsxOld); await fs.rename(tsxOld, tsxNew); } catch {}
    }
    res.json({ ok: true, newPath: path.relative(LEARN_DIR, newFullPath) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete file or folder
app.post('/api/delete', async (req, res) => {
  try {
    const { path: itemPath } = req.body;
    const fullPath = path.join(LEARN_DIR, itemPath);
    if (!fullPath.startsWith(LEARN_DIR) || fullPath === LEARN_DIR) return res.status(400).json({ error: 'Invalid path' });
    await fs.rm(fullPath, { recursive: true });
    // Also delete companion .tsx if deleting a .md file
    if (fullPath.endsWith('.md')) {
      const tsxPath = fullPath.replace(/\.md$/, '.tsx');
      try { await fs.rm(tsxPath); } catch {}
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Move file or folder
app.post('/api/move', async (req, res) => {
  try {
    const { from, to } = req.body;
    const fullFrom = path.join(LEARN_DIR, from);
    const name = path.basename(fullFrom);
    const fullTo = path.join(LEARN_DIR, to, name);
    if (!fullTo.startsWith(LEARN_DIR)) return res.status(400).json({ error: 'Invalid path' });
    await fs.mkdir(path.join(LEARN_DIR, to), { recursive: true });
    await fs.rename(fullFrom, fullTo);
    // Also move companion .tsx if moving a .md file
    if (fullFrom.endsWith('.md')) {
      const tsxFrom = fullFrom.replace(/\.md$/, '.tsx');
      const tsxTo = fullTo.replace(/\.md$/, '.tsx');
      try { await fs.access(tsxFrom); await fs.rename(tsxFrom, tsxTo); } catch {}
    }
    res.json({ ok: true, newPath: path.relative(LEARN_DIR, fullTo) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3001, () => console.log('API server running on :3001'));
