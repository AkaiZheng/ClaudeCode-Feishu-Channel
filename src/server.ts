#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
  getSenderOpenId,
  type Access,
  type InboundEvent,
} from './access.ts'
import {
  FeishuClient,
  chunk,
  parsePost,
  extractImageKeys,
  extractImageRefsFromRendered,
  extractFileInfo,
  extractFileRefsFromRendered,
  safeMessageId,
  buildNotificationContent,
} from './feishu.ts'
import { INSTRUCTIONS } from './instructions.ts'

const HOME = homedir()
const STATE_DIR = resolveStateDir(HOME)
const ENV_FILE = join(STATE_DIR, '.env')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const IMAGES_DIR = join(STATE_DIR, 'images')
const FILES_DIR = join(STATE_DIR, 'files')

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

const PID_FILE = join(STATE_DIR, 'server.pid')
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    try {
      process.kill(stale, 0) // existence probe; throws ESRCH if dead
      process.stderr.write(`feishu channel: replacing stale poller pid=${stale}\n`)
      process.kill(stale, 'SIGTERM')
    } catch {
      // stale PID file — previous process already gone
    }
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

process.on('unhandledRejection', err => {
  process.stderr.write(`feishu channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`feishu channel: uncaught exception: ${err}\n`)
})

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

// Typing indicator: add a reaction when processing, remove after reply.
const TYPING_EMOJI = 'OnIt'
// Map from chat_id to { messageId, reactionId } for active typing indicators.
const activeReactions = new Map<string, { messageId: string; reactionId: string }>()

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Reply on Feishu with markdown. Supports bold, italic, links, code blocks, lists, etc. Pass chat_id verbatim from the inbound <channel> block. Optionally pass reply_to (an om_xxx message_id) to thread under a specific earlier message.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Target conversation ID (oc_xxx)' },
          text: { type: 'string', description: 'Message body in markdown format' },
          reply_to: {
            type: 'string',
            description: 'message_id (om_xxx) to thread under. Omit for normal replies.',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'reply_image',
      description:
        'Send an image on Feishu. Provide base64-encoded image data (PNG/JPEG). The image will be uploaded to Feishu and sent to the chat. Optionally reply_to to thread under a message.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Target conversation ID (oc_xxx)' },
          image_data: { type: 'string', description: 'Base64-encoded image data (supports data URI or raw base64)' },
          reply_to: {
            type: 'string',
            description: 'message_id (om_xxx) to thread under. Omit for normal send.',
          },
        },
        required: ['chat_id', 'image_data'],
      },
    },
    {
      name: 'reply_file',
      description:
        'Send a file on Feishu. Provide the absolute path to a local file. The file will be uploaded to Feishu and sent to the chat. Optionally reply_to to thread under a message.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Target conversation ID (oc_xxx)' },
          file_path: { type: 'string', description: 'Absolute path to the file to send' },
          reply_to: {
            type: 'string',
            description: 'message_id (om_xxx) to thread under. Omit for normal send.',
          },
        },
        required: ['chat_id', 'file_path'],
      },
    },
  ],
}))

// Helper: clear typing indicator for a chat after reply
function clearTypingIndicator(chatId: string): void {
  const active = activeReactions.get(chatId)
  if (active) {
    activeReactions.delete(chatId)
    feishu.removeReaction(active.messageId, active.reactionId).catch(err => {
      process.stderr.write(`feishu channel: remove typing indicator failed: ${err}\n`)
    })
  }
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>

    if (req.params.name === 'reply') {
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
        try {
          // Prefer markdown for rich formatting (links, code blocks, lists)
          if (i === 0 && replyTo) {
            id = feishu.replyMarkdown(replyTo, piece)
          } else {
            id = feishu.sendMarkdown(chatId, piece)
          }
        } catch (err) {
          process.stderr.write(`feishu channel: markdown send failed, falling back to text: ${err}\n`)
          // Fallback to plain text if markdown send fails
          if (i === 0 && replyTo) {
            id = await feishu.replyText(replyTo, piece)
          } else {
            id = await feishu.sendText(chatId, piece)
          }
        }
        sentIds.push(id)
      }

      clearTypingIndicator(chatId)

      const label = sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
      return { content: [{ type: 'text', text: label }] }
    }

    if (req.params.name === 'reply_image') {
      const chatId = String(args.chat_id ?? '')
      let imageData = String(args.image_data ?? '')
      const replyTo = args.reply_to != null ? String(args.reply_to) : undefined

      if (!chatId) throw new Error('reply_image: chat_id is required')
      if (!imageData) throw new Error('reply_image: image_data is required')

      assertAllowedChat(readAccessFile(ACCESS_FILE), chatId)

      // Strip data URI prefix if present
      const dataUriMatch = imageData.match(/^data:image\/[^;]+;base64,(.+)$/)
      if (dataUriMatch) imageData = dataUriMatch[1]!

      // Write to temp file for lark-cli
      const tmp = join(tmpdir(), `feishu-send-${Date.now()}.png`)
      writeFileSync(tmp, Buffer.from(imageData, 'base64'))

      let mid: string
      try {
        if (replyTo) {
          mid = feishu.replyImage(replyTo, tmp)
        } else {
          mid = feishu.sendImage(chatId, tmp)
        }
      } finally {
        try { unlinkSync(tmp) } catch {}
      }

      clearTypingIndicator(chatId)
      return { content: [{ type: 'text', text: `image sent (id: ${mid})` }] }
    }

    if (req.params.name === 'reply_file') {
      const chatId = String(args.chat_id ?? '')
      const filePath = String(args.file_path ?? '')
      const replyTo = args.reply_to != null ? String(args.reply_to) : undefined

      if (!chatId) throw new Error('reply_file: chat_id is required')
      if (!filePath) throw new Error('reply_file: file_path is required')

      assertAllowedChat(readAccessFile(ACCESS_FILE), chatId)

      let mid: string
      if (replyTo) {
        mid = feishu.replyFile(replyTo, filePath)
      } else {
        mid = feishu.sendFile(chatId, filePath)
      }

      clearTypingIndicator(chatId)
      return { content: [{ type: 'text', text: `file sent (id: ${mid})` }] }
    }

    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `reply failed: ${msg}` }], isError: true }
  }
})

// ---------------------------------------------------------------------------
// Event ingress — WebSocket → gate → notification to Claude.
// ---------------------------------------------------------------------------

async function onEvent(event: InboundEvent): Promise<void> {
  const access = readAccessFile(ACCESS_FILE)
  // Pass undefined as botOpenId: the bot's own open_id resolution is a P1
  // concern. The isMentioned() fallback treats any mention as sufficient in
  // that case. Do NOT pass APP_ID here — it's `cli_xxx`, not an open_id.
  const result = gate(event, access, Date.now(), undefined)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    saveAccess(ACCESS_FILE, result.nextAccess)
    const cmd = `/feishu:access pair ${result.code}`
    const lead = result.isResend ? '仍在等待配对' : '需要配对'
    const body = `${lead}｜pairing required\n\n在 Claude Code 终端里运行：\n${cmd}\n\n(Feishu bot — pairing code ${result.code})`
    try {
      await feishu.sendText(result.chatId, body)
    } catch (err) {
      process.stderr.write(`feishu channel: failed to send pairing prompt: ${err}\n`)
    }
    return
  }

  // Opportunistic chat_id capture: if the sender is in allowFrom but we haven't
  // recorded their P2P chat_id in allowChats yet (first inbound after Z-mode
  // boot or /feishu:access allow), learn it now so the reply tool can target
  // this chat.
  if (event.message.chat_type === 'p2p'
      && access.allowFrom.includes(getSenderOpenId(event) ?? '')
      && !access.allowChats.includes(event.message.chat_id)) {
    access.allowChats.push(event.message.chat_id)
    saveAccess(ACCESS_FILE, access)
  }

  // Typing indicator: add reaction to the incoming message
  try {
    const reactionId = await feishu.addReaction(event.message.message_id, TYPING_EMOJI)
    activeReactions.set(event.message.chat_id, {
      messageId: event.message.message_id,
      reactionId,
    })
  } catch (err) {
    // Non-fatal — the message will still be delivered without the indicator
    process.stderr.write(`feishu channel: typing indicator failed: ${err}\n`)
  }

  const chatType = event.message.chat_type === 'group' ? 'group' : 'p2p'
  const ts = new Date(Number(event.message.create_time)).toISOString()

  // Primary path: let lark-cli render the content (handles post variants,
  // merge_forward, sticker, etc.). Fall back to local parsing if lark-cli is
  // unreachable — degraded but still delivers something.
  let content: string
  let imageKeys: string[]
  let fileInfos: Array<{ fileKey: string; fileName: string }> = []
  try {
    const rendered = feishu.fetchRenderedMessage(event.message.message_id)
    const imgRefs = extractImageRefsFromRendered(rendered.content)
    const fileRefs = extractFileRefsFromRendered(imgRefs.text)
    content = fileRefs.text
    imageKeys = imgRefs.imageKeys
    fileInfos = fileRefs.files
  } catch (err) {
    process.stderr.write(`feishu channel: mget failed, falling back to local parse: ${err}\n`)
    content = parsePost(event.message.message_type, event.message.content)
    imageKeys = extractImageKeys(event.message.message_type, event.message.content)
    const fi = extractFileInfo(event.message.message_type, event.message.content)
    if (fi) fileInfos = [fi]
  }

  const safeMsgId = safeMessageId(event.message.message_id)

  // Download images
  const imagePaths: string[] = []
  for (let i = 0; i < imageKeys.length; i++) {
    const ik = imageKeys[i]!
    try {
      const base = `${safeMsgId}-${i + 1}`
      const { path } = feishu.downloadImage(event.message.message_id, ik, IMAGES_DIR, base)
      imagePaths.push(path)
    } catch (err) {
      process.stderr.write(`feishu channel: image download failed (${ik}): ${err}\n`)
    }
  }

  // Download files
  const filePaths: string[] = []
  for (const fi of fileInfos) {
    try {
      const path = feishu.downloadFile(event.message.message_id, fi.fileKey, FILES_DIR, fi.fileName)
      filePaths.push(path)
    } catch (err) {
      process.stderr.write(`feishu channel: file download failed (${fi.fileKey}): ${err}\n`)
    }
  }

  // Build notification with image and file refs
  let fullContent = buildNotificationContent(content, imagePaths)
  if (filePaths.length > 0) {
    const fileRefs = filePaths.map((p, i) => `[file ${i + 1}: ${p}]`).join('\n')
    fullContent = fullContent ? `${fullContent}\n${fileRefs}` : fileRefs
  }

  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: fullContent,
        meta: {
          chat_id: event.message.chat_id,
          message_id: event.message.message_id,
          user_id: getSenderOpenId(event),
          user: getSenderOpenId(event),
          chat_type: chatType,
          ts,
        },
      },
    })
  } catch (err) {
    process.stderr.write(`feishu channel: failed to forward inbound: ${err}\n`)
  }
}

feishu.subscribe(onEvent, err => {
  process.stderr.write(`feishu channel: ws error: ${err}\n`)
})

// Poll approved/ for pairing confirmations written by /feishu:access pair.
// Telegram does this every 5s; we match that cadence.
const approvalsTimer = setInterval(async () => {
  for (const openId of readApprovals(STATE_DIR)) {
    try {
      await feishu.sendText(openId, '已配对 ✅ — you can now talk to Claude.', 'open_id')
    } catch (err) {
      process.stderr.write(`feishu channel: approval confirm to ${openId} failed: ${err}\n`)
    } finally {
      removeApproval(STATE_DIR, openId)
    }
  }
}, 5000)
approvalsTimer.unref()

// Connect stdio last — Claude Code waits for the MCP handshake before
// sending any tool calls, so prior work runs first.
await mcp.connect(new StdioServerTransport())

// ---------------------------------------------------------------------------
// Shutdown: clean up the PID file, then let the process exit.
// ---------------------------------------------------------------------------
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('feishu channel: shutting down\n')
  try {
    if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) rmSync(PID_FILE)
  } catch {}
  setTimeout(() => process.exit(0), 2000).unref()
  void feishu.close().finally(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// Orphan watchdog — if our parent chain is severed (Claude Code crashed or
// the shell that launched us went away), reparent detection + destroyed
// stdin are the signals. Match Telegram's 5s cadence.
const bootPpid = process.ppid
setInterval(() => {
  const orphaned =
    (process.platform !== 'win32' && process.ppid !== bootPpid) ||
    process.stdin.destroyed ||
    process.stdin.readableEnded
  if (orphaned) shutdown()
}, 5000).unref()

export { feishu, ACCESS_FILE, STATE_DIR, USER_OPEN_ID }
