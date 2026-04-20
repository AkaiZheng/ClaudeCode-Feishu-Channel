# Feishu Channel — Automated Setup Guide

> **For Claude Code**: Follow these steps sequentially. Each step that requires user interaction will output a URL — present it to the user and wait for confirmation before proceeding.

## Prerequisites Check

```bash
# 1. Check Bun
bun --version || { echo "Installing Bun..."; curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"; }

# 2. Check lark-cli
lark-cli --version || { echo "Installing lark-cli..."; npm install -g @larksuite/cli; }
```

## Step 1: App Configuration

Check if lark-cli already has an app configured:

```bash
lark-cli config show
```

**If no app is configured** (error or empty), create one:

```bash
# Run in background — outputs a URL for the user to open.
# The URL auto-creates a Feishu app with correct settings.
# Command blocks until user completes browser flow.
lark-cli config init --new
```

→ Extract the URL from output, send to user. Wait for command to exit (success).

**If an app already exists**, verify it has the required scopes:

```bash
lark-cli auth scopes | grep -E "im:message"
```

Required scopes: `im:message:receive_as_bot`, `im:message:send_as_bot`, `im:message` (for reactions).

## Step 2: User Login

```bash
# Check if user is logged in
lark-cli auth status
```

**If not logged in**, initiate login:

```bash
# Run in background — outputs a device-code URL.
# User opens URL and confirms authorization.
lark-cli auth login --scope "im:message:receive_as_bot im:message:send_as_bot im:message"
```

→ Extract the URL from output, send to user. Wait for command to exit (success).

## Step 3: Event Subscription Verification

The app needs `im.message.receive_v1` event subscription with **长连接 (WebSocket)** mode. This cannot be configured via API — verify by running smoke test:

```bash
cd /path/to/ClaudeCode-Feishu-Channel
bun install
timeout 10 bun scripts/smoke.ts 2>&1
```

If output contains `event-dispatch is ready` → WebSocket subscription is working.

If it fails with connection errors → tell the user:
> 请在飞书开发者后台完成以下配置：
> 1. 打开 https://open.feishu.cn → 你的应用 → 事件与回调
> 2. 选择「使用长连接接收事件」
> 3. 添加事件：im.message.receive_v1
> 4. 如果应用未发布，点击「创建版本」并提交审批

## Step 4: Write Channel Config

```bash
# Auto-generate .env from lark-cli config
FEISHU_STATE_DIR="${HOME}/.claude/channels/feishu"
mkdir -p "$FEISHU_STATE_DIR"
chmod 700 "$FEISHU_STATE_DIR"

# Extract from lark-cli
APP_ID=$(lark-cli config show 2>&1 | grep -o 'cli_[a-z0-9]*')
APP_SECRET=$(lark-cli config show 2>&1 | grep -oP 'appSecret:\s*\K\S+' || echo "")

# If secret not visible in config show, it's in keychain — ask user
if [ -z "$APP_SECRET" ]; then
  echo "需要 App Secret。请从飞书开发者后台复制："
  echo "  https://open.feishu.cn → 你的应用 → 凭证与基础信息 → App Secret"
  # Wait for user to provide it
fi

cat > "$FEISHU_STATE_DIR/.env" << EOF
FEISHU_APP_ID=${APP_ID}
FEISHU_APP_SECRET=${APP_SECRET}
EOF
chmod 600 "$FEISHU_STATE_DIR/.env"
```

## Step 5: Register MCP Server

For project-local usage, ensure `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "feishu": {
      "command": "bun",
      "args": ["run", "--silent", "start"]
    }
  }
}
```

For user-wide (any project), add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "feishu": {
      "command": "bun",
      "args": ["/absolute/path/to/ClaudeCode-Feishu-Channel/src/server.ts"]
    }
  }
}
```

## Step 6: Launch

```bash
cd /path/to/ClaudeCode-Feishu-Channel
claude --dangerously-load-development-channels server:feishu
```

## Verification

After launch, ask the user to send a DM to the bot in Feishu. You should see:

```
← feishu · ou_xxxxx:
<their message>
```

Reply using the `feishu` tool. Done! 🎉

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `event-dispatch` never appears | App has no WebSocket event subscription — see Step 3 |
| `FEISHU_APP_SECRET required` | Secret missing from .env — see Step 4 |
| Messages arrive but reply fails with "not allowlisted" | Run `/feishu:access allow <open_id>` or check `~/.claude/channels/feishu/access.json` |
| `lark-cli config init --new` times out | User didn't complete browser flow within 5 minutes — retry |
