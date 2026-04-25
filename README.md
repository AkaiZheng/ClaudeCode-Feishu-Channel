# Feishu Channel for Claude Code

Chat with Claude Code from Feishu. Messages go in, replies come back — all in one conversation.

## Install

Paste this into your terminal:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/AkaiZheng/ClaudeCode-Feishu-Channel/main/install.sh)
```

The script installs dependencies, creates a Feishu app, and configures credentials. Just open the browser links when prompted.

Then start Claude Code:

```bash
claude --dangerously-load-development-channels server:feishu
```

Send your bot a DM in Feishu — done.

## Pairing

First-time setup auto-whitelists you. Other users get a 6-digit pairing code from the bot — run `/feishu:access pair <code>` in Claude Code to approve.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| No messages received | Enable long-connection events + `im.message.receive_v1` in Feishu console |
| "FEISHU_APP_SECRET required" | Check `~/.claude/channels/feishu/.env` |
| "chat X is not allowlisted" | Run `/feishu:access allow <open_id>` |

<details>
<summary>Manual install</summary>

```bash
# Prerequisites: bun, lark-cli
git clone https://github.com/AkaiZheng/ClaudeCode-Feishu-Channel.git
cd ClaudeCode-Feishu-Channel
bun install
bun scripts/setup.ts
```

</details>

## License

MIT
