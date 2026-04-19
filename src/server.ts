#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  loadDotEnv,
  resolveStateDir,
  resolveDomain,
  importFromLarkCli,
} from './config.ts'
import {
  readAccessFile,
  saveAccess,
  defaultAccess,
  assertAllowedChat,
  readApprovals,
  removeApproval,
  gate,
  type Access,
  type InboundEvent,
} from './access.ts'
import { FeishuClient, chunk, parsePost } from './feishu.ts'
import { INSTRUCTIONS } from './instructions.ts'

const HOME = homedir()
const STATE_DIR = resolveStateDir(HOME)
const ENV_FILE = join(STATE_DIR, '.env')
const ACCESS_FILE = join(STATE_DIR, 'access.json')

// Boot step 1: load .env (no-op if missing).
loadDotEnv(ENV_FILE)

// Boot step 2: require credentials. If the secret is missing and lark-cli has
// one inline, import it; otherwise bail with a clear message.
if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  const imported = importFromLarkCli(HOME)
  for (const [k, v] of Object.entries(imported.env)) {
    if (v && process.env[k] === undefined) process.env[k] = v
  }
  if (imported.env.FEISHU_APP_ID && !process.env.FEISHU_USER_OPEN_ID && imported.env.FEISHU_USER_OPEN_ID) {
    process.env.FEISHU_USER_OPEN_ID = imported.env.FEISHU_USER_OPEN_ID
  }
  if (imported.brand && !process.env.FEISHU_DOMAIN) {
    process.env.FEISHU_DOMAIN = resolveDomain(imported.brand)
  }
  if (imported.secretSource === 'keychain' && !process.env.FEISHU_APP_SECRET) {
    process.stderr.write(
      `feishu channel: imported ${imported.env.FEISHU_APP_ID ? 'appId' : ''} from lark-cli,\n` +
      `  but appSecret is in your OS keychain and cannot be read programmatically.\n` +
      `  Set FEISHU_APP_SECRET in ${ENV_FILE} (0o600) or run /feishu:configure set FEISHU_APP_SECRET=<secret>\n`,
    )
  }
}

const APP_ID = process.env.FEISHU_APP_ID
const APP_SECRET = process.env.FEISHU_APP_SECRET
const DOMAIN = process.env.FEISHU_DOMAIN || resolveDomain(undefined)
const USER_OPEN_ID = process.env.FEISHU_USER_OPEN_ID

if (!APP_ID || !APP_SECRET) {
  process.stderr.write(
    `feishu channel: FEISHU_APP_ID and FEISHU_APP_SECRET are required.\n` +
    `  Create ${ENV_FILE} (0o600) with lines like:\n` +
    `    FEISHU_APP_ID=cli_xxxxxx\n` +
    `    FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx\n` +
    `  or run /feishu:configure import to pre-fill from lark-cli.\n`,
  )
  process.exit(1)
}

// Ensure the state dir exists with restrictive perms before anything else
// touches access.json or approved/.
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

// First-boot: if access.json doesn't exist and we know the operator's open_id
// from lark-cli, pre-populate allowFrom so the operator can self-chat with
// zero configuration (Z mode from the design).
function ensureAccessInitialized(): Access {
  const a = readAccessFile(ACCESS_FILE)
  // readAccessFile() returns defaultAccess() when the file is missing — we
  // can detect first-boot by checking if the file exists on disk now.
  const exists = (() => { try { readFileSync(ACCESS_FILE, 'utf8'); return true } catch { return false } })()
  if (!exists && USER_OPEN_ID && !a.allowFrom.includes(USER_OPEN_ID)) {
    a.allowFrom.push(USER_OPEN_ID)
    saveAccess(ACCESS_FILE, a)
    process.stderr.write(
      `feishu channel: first boot — auto-allowlisted ${USER_OPEN_ID} (from FEISHU_USER_OPEN_ID).\n`,
    )
  }
  return a
}
ensureAccessInitialized()

// MCP server: declare the channel capability (required) and the tools
// capability (required because we expose reply). No permission relay in P0.
const mcp = new Server(
  { name: 'feishu', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
)

// SDK client is constructed here; subscription happens in Task 11.
const feishu = new FeishuClient({ appId: APP_ID, appSecret: APP_SECRET, domain: DOMAIN })

// ---------------------------------------------------------------------------
// Tool registry — P0 has only `reply`.
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Reply on Feishu. Pass chat_id verbatim from the inbound <channel> block. Optionally pass reply_to (an om_xxx message_id) to thread under a specific earlier message; the first chunk is threaded, later chunks send plainly.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Target conversation ID (oc_xxx)' },
          text: { type: 'string', description: 'Message body; any UTF-8 string' },
          reply_to: {
            type: 'string',
            description: 'message_id (om_xxx) to thread under. Omit for normal replies.',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    if (req.params.name !== 'reply') {
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const chatId = String(args.chat_id ?? '')
    const text = String(args.text ?? '')
    const replyTo = args.reply_to != null ? String(args.reply_to) : undefined

    if (!chatId) throw new Error('reply: chat_id is required')
    if (!text) throw new Error('reply: text is required')

    assertAllowedChat(readAccessFile(ACCESS_FILE), chatId)

    const CHUNK_LIMIT = 5000
    const chunks = chunk(text, CHUNK_LIMIT, 'newline')
    const sentIds: string[] = []
    for (const [i, piece] of chunks.entries()) {
      let id: string
      if (i === 0 && replyTo) {
        id = await feishu.replyText(replyTo, piece)
      } else {
        id = await feishu.sendText(chatId, piece)
      }
      sentIds.push(id)
    }
    const label = sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
    return { content: [{ type: 'text', text: label }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `reply failed: ${msg}` }], isError: true }
  }
})

// Connect stdio last — Claude Code waits for the MCP handshake before
// sending any tool calls, so prior work runs first.
await mcp.connect(new StdioServerTransport())

// Tasks 11 and 12 will extend this file with the event subscription,
// approvals polling, and PID lifecycle.
export { feishu, ACCESS_FILE, STATE_DIR, USER_OPEN_ID }
