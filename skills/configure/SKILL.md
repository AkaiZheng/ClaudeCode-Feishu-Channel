---
name: feishu-configure
description: Configure the Feishu channel — import credentials from lark-cli, set individual env vars, show or validate the current config.
---

# `/feishu:configure`

Configure the Feishu channel's `.env` at `~/.claude/channels/feishu/.env` and validate that it works.

## Subcommands

### `import`

Run the Bun-based import helper that reads `~/.lark-cli/config.json` and writes `FEISHU_APP_ID`, `FEISHU_USER_OPEN_ID`, and `FEISHU_DOMAIN` (via brand resolution) into `~/.claude/channels/feishu/.env`. The lark-cli tool stores `appSecret` in the OS keychain, so the import **cannot** populate `FEISHU_APP_SECRET` — the user must set it manually afterward.

Steps Claude should take:

1. Use `Bash` to run (substituting the absolute path to the installed plugin):
   ```bash
   bun -e "const { importFromLarkCli, resolveDomain } = await import('${CLAUDE_PLUGIN_ROOT}/src/config.ts'); const r = importFromLarkCli(process.env.HOME); console.log(JSON.stringify({env: r.env, domain: r.brand ? resolveDomain(r.brand) : undefined, secretSource: r.secretSource, reason: r.reason}));"
   ```
2. If the JSON output has `env.FEISHU_APP_ID`, merge its keys into `~/.claude/channels/feishu/.env` (Read, Edit) — preserving unrelated lines.
3. If `secretSource === 'keychain'`, tell the user: "FEISHU_APP_SECRET must be set manually. Run `/feishu:configure set FEISHU_APP_SECRET=<secret>` once you have it."
4. `chmod 0o600 ~/.claude/channels/feishu/.env`.

### `set <key>=<value>`

Open `~/.claude/channels/feishu/.env` (create if missing with mode 0o600), update or append the requested `KEY=VALUE` line. Only these keys are valid: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOMAIN`, `FEISHU_USER_OPEN_ID`, `FEISHU_STATE_DIR`.

### `show`

Read `~/.claude/channels/feishu/.env` and print it, replacing the value of `FEISHU_APP_SECRET` with `****` before showing to the user. Do not reveal the secret.

### `check`

Run:
```bash
bun -e "import('@larksuiteoapi/node-sdk').then(async ({ Client }) => { const c = new Client({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, domain: process.env.FEISHU_DOMAIN || 'https://open.feishu.cn' }); try { await c.auth.tenantAccessToken.internal({ data: { app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET } }); console.log('ok'); } catch (e) { console.error(String(e)); process.exit(1) } })"
```

Report success/failure plainly. On failure, suggest checking the App Open Platform developer console: https://open.feishu.cn/app.

## Prerequisites (platform side, one-time)

The user must configure these in the Feishu Open Platform console:

1. 事件与回调 → 使用长连接接收事件
2. Subscribe event: `im.message.receive_v1`
3. Grant scopes: `im:message:receive_as_bot`, `im:message:send_as_bot`
4. 应用可见范围 includes the operator's user
5. Create a version → admin approval
