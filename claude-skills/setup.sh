#!/usr/bin/env bash
# Nomi dev workflow skills — link into Claude Code
# Run once after cloning:  bash claude-skills/setup.sh
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "Setting up Nomi dev skills..."

mkdir -p .claude

if [ -L .claude/skills ]; then
  echo "✓ .claude/skills symlink already exists"
elif [ -d .claude/skills ]; then
  echo "⚠ .claude/skills is a real directory, replacing with symlink..."
  rm -rf .claude/skills
  ln -s ../claude-skills .claude/skills
  echo "✓ .claude/skills → claude-skills"
else
  ln -s ../claude-skills .claude/skills
  echo "✓ .claude/skills → claude-skills"
fi

echo ""
echo "Done! Restart Claude Code to pick up the skills."
echo "Available: room-init · room · timeline-init · plan-milestones ·"
echo "           prompt-gen · dev · commit-sync · room-status · random-contexts"
