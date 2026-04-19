# Feishu Channel for Claude Code

A [Claude Code channel](https://code.claude.com/docs/en/channels) that bridges Feishu (Lark) DMs into your running session. Send a message to your bot in Feishu; Claude reads it, does the work, and replies back through the same chat.

Status: P0 — text DMs with pairing and zero-config self-allowlisting for the lark-cli-authenticated user.

## Prerequisites

- [Bun](https://bun.sh) installed (`bun --version` must succeed)
- A Feishu app with:
  - 事件与回调 → "使用长连接接收事件"
  - Subscribed event: `im.message.receive_v1`
  - App scopes: `im:message:receive_as_bot`, `im:message:send_as_bot`
  - 应用可见范围 including you
  - A released version (创建版本 → approved)
- (Optional but recommended) [lark-cli](https://github.com/larksuite/cli) installed and authenticated — the channel auto-imports your `appId`, `brand`, and `userOpenId`.

## Install

```bash
# Option A — plugin install (once this plugin is on the Anthropic allowlist; P0 is development only)
/plugin install feishu@claude-plugins-official      # not yet available

# Option B — development install
git clone <this repo> ~/claude-plugins/feishu
cd ~/claude-plugins/feishu
bun install
```

Then register it in your project's `.mcp.json` (or `~/.claude.json` for a user-wide install):

```json
{
  "mcpServers": {
    "feishu": { "command": "bun", "args": ["/absolute/path/to/this/repo/src/server.ts"] }
  }
}
```

## Configure

Set `FEISHU_APP_ID` and `FEISHU_APP_SECRET` in `~/.claude/channels/feishu/.env` (mode 0o600):

```
FEISHU_APP_ID=cli_xxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
```

If you have lark-cli installed, populate the non-secret fields automatically inside Claude Code:

```
/feishu:configure import
```

Then follow the prompt to set the secret:

```
/feishu:configure set FEISHU_APP_SECRET=<your secret>
```

Confirm connectivity:

```
/feishu:configure check
```

## Run

```bash
claude --dangerously-load-development-channels server:feishu
```

P0 is not yet on the official allowlist, so the development flag is required.

## First-time pairing

**If you imported from lark-cli**: your own `open_id` is pre-allowlisted. DM the bot "hi" — it arrives in Claude.

**If someone else is the first sender**: the bot replies with a 6-char pairing code. In Claude Code, run:

```
/feishu:access pair <code>
```

See `skills/access/SKILL.md` for the full subcommand set (allow/revoke/list/policy/pending).

## Troubleshoot

- **"FEISHU_APP_ID and FEISHU_APP_SECRET are required"** — you skipped `/feishu:configure set FEISHU_APP_SECRET=`.
- **`/mcp` says "Failed to connect"** — check `~/.claude/debug/<session>.txt` for the stderr from `server.ts`.
- **No events arrive** — confirm long-connection event subscription in the Feishu console, the `im.message.receive_v1` subscription, and that you're in the app's visibility range. Also stop any concurrent `lark-cli event +subscribe` for the same app (Feishu splits events across WebSocket consumers).
- **"chat X is not allowlisted"** on outbound — Claude tried to reply to a chat that isn't in `allowFrom`. Run `/feishu:access list` to see current state.

## Smoke test

```bash
bun scripts/smoke.ts
```

Subscribes for 30 s; any DM you send the bot gets a "smoke ok" reply.

## Security

- Sender allowlist; prompt injection surface is gated before Claude ever sees the text.
- Outbound targets gated by the same list — Claude cannot exfiltrate to arbitrary chats.
- State-dir files are never attachable via future file-reply extensions (P1).
- Credential files are `chmod 0o600` at all times.

See [the design spec](docs/superpowers/specs/2026-04-19-feishu-channel-design.md) for full architecture.
