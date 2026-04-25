#!/usr/bin/env bash
# One-line installer for Feishu Channel for Claude Code
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/AkaiZheng/ClaudeCode-Feishu-Channel/main/install.sh)
set -euo pipefail

REPO="https://github.com/AkaiZheng/ClaudeCode-Feishu-Channel.git"
INSTALL_DIR="${HOME}/.claude/channels/feishu-channel"

echo ""
echo "🚀 Installing Feishu Channel for Claude Code..."
echo ""

# ─── Check prerequisites ──────────────────────────────────────

if ! command -v bun &>/dev/null; then
  echo "📦 Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v lark-cli &>/dev/null; then
  echo "📦 Installing lark-cli..."
  npm install -g @larksuite/cli
fi

# ─── Clone or update ──────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "📂 Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --ff-only 2>/dev/null || true
else
  echo "📂 Cloning repository..."
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ─── Install deps ─────────────────────────────────────────────

echo "📦 Installing dependencies..."
bun install --no-summary

# ─── Run interactive setup ────────────────────────────────────

echo ""
bun scripts/setup.ts
