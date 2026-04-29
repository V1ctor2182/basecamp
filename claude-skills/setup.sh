#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

mkdir -p "$TARGET_DIR"

echo "Installing Nomi dev skills → $TARGET_DIR"

for skill_dir in "$SCRIPT_DIR"/*/; do
  skill_name="$(basename "$skill_dir")"
  [ -f "$skill_dir/SKILL.md" ] || continue

  dest="$TARGET_DIR/$skill_name"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    rm -rf "$dest"
  fi
  cp -R "$skill_dir" "$dest"
  echo "  ✓ $skill_name"
done

echo
echo "Done. Restart Claude Code to pick up the new skills."
