#!/bin/bash
# init-career — Career System 一键初始化
#
# 从 data/career/*.example.yml 复制出真实文件（不覆盖已有）。
# 运行多次幂等。
#
# 用法:
#   npm run init:career
#   或
#   bash scripts/init-career.sh

set -e

CAREER_DIR="data/career"

echo "🚀 Initializing Career System..."
echo ""

# Ensure all subdirs exist (m1 已建，防御性再跑一次)
mkdir -p \
  "$CAREER_DIR/resumes" \
  "$CAREER_DIR/qa-bank" \
  "$CAREER_DIR/site-adapters" \
  "$CAREER_DIR/reports" \
  "$CAREER_DIR/output" \
  "$CAREER_DIR/drafts" \
  "$CAREER_DIR/feedback" \
  "$CAREER_DIR/apply-sessions"

# Copy .example → real file, skip if already exists
copy_example() {
  local src="$1"
  local dst="$2"
  if [ ! -f "$src" ]; then
    echo "  ⚠️  Source not found: $src (skip)"
    return
  fi
  if [ -f "$dst" ]; then
    echo "  ✓ $dst already exists (skip)"
  else
    cp "$src" "$dst"
    echo "  ✅ Created $dst (from $(basename $src))"
  fi
}

echo "Copying example templates..."
copy_example "$CAREER_DIR/preferences.example.yml"     "$CAREER_DIR/preferences.yml"
copy_example "$CAREER_DIR/portals.example.yml"         "$CAREER_DIR/portals.yml"
copy_example "$CAREER_DIR/qa-bank/legal.example.yml"   "$CAREER_DIR/qa-bank/legal.yml"

echo ""
echo "✅ Done. Next steps:"
echo "  1. Edit $CAREER_DIR/preferences.yml — 填你的目标岗位 / comp / hard_filters"
echo "  2. Edit $CAREER_DIR/portals.yml     — 定制你想扫的公司和 GitHub repo"
echo "  3. Edit $CAREER_DIR/qa-bank/legal.yml — 填你的 visa / EEO 等法律答案"
echo "  4. 可选: create $CAREER_DIR/identity.yml (参考 README)"
echo ""
echo "Note: preferences.yml / portals.yml commit 进 git（可复用），"
echo "      legal.yml / identity.yml 敏感 — gitignored。"
