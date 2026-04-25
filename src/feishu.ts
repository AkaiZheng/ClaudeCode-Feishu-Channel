// Pure helpers have no SDK / network dependency — isolate them here so
// the SDK wrapper below doesn't drag them into the test matrix.

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (!text) return []
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

type PostNode = {
  tag?: string
  text?: string
  href?: string
  user_name?: string
  image_key?: string
  [k: string]: unknown
}
type PostLocale = { title?: string; content?: PostNode[][] }
type PostPayload = Record<string, PostLocale>

// Feishu post payloads come in two shapes:
//   1. Flat locale — `{title, content}` directly (what the client usually sends)
//   2. i18n-wrapped — `{zh_cn: {title, content}, en_us: {...}}`
// Pick whichever the payload actually is so both branches see the locale.
function resolvePostLocale(parsed: unknown): PostLocale | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined
  const obj = parsed as Record<string, unknown>
  if ('content' in obj || 'title' in obj) return obj as PostLocale
  const payload = obj as PostPayload
  return payload.zh_cn ?? payload.en_us ?? Object.values(payload)[0]
}

// Feishu message content arrives as a double-encoded JSON string. The outer
// parse is always required; the inner shape depends on msg_type. We flatten
// post (rich text) into simple markdown-ish plaintext so Claude sees a single
// readable string in <channel content="...">.
export function parsePost(msgType: string, rawContent: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(rawContent) } catch { return '' }
  if (msgType === 'text') {
    if (parsed && typeof parsed === 'object' && 'text' in parsed) {
      return String((parsed as { text?: unknown }).text ?? '')
    }
    return ''
  }
  if (msgType === 'post') {
    const locale = resolvePostLocale(parsed)
    if (!locale) return ''
    const lines: string[] = []
    if (locale.title) lines.push(locale.title)
    for (const para of locale.content ?? []) {
      const parts = para.map(renderNode).filter(Boolean)
      lines.push(parts.join(''))
    }
    return lines.filter(l => l.length > 0).join('\n\n')
  }
  if (msgType === 'image') {
    const ik = (parsed as { image_key?: string } | null)?.image_key
    return ik ? `[image:${ik}]` : '(image)'
  }
  if (msgType === 'file') {
    const name = (parsed as { file_name?: string } | null)?.file_name
    return name ? `(file: ${name})` : '(file)'
  }
  return `(${msgType})`
}

function renderNode(node: PostNode): string {
  const text = typeof node.text === 'string' ? node.text : ''
  switch (node.tag) {
    case 'text':
      return text
    case 'a':
      return node.href ? `[${text || node.href}](${node.href})` : text
    case 'at':
      return node.user_name ? `@${node.user_name}` : '@'
    case 'img':
      return '(image)'
    case 'code_block':
      return '```\n' + text + '\n```'
    case 'hr':
      return '---'
    default:
      return text
  }
}

// Extract all image_key values from a message for downloading.
export function extractImageKeys(msgType: string, rawContent: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(rawContent) } catch { return [] }
  const keys: string[] = []
  if (msgType === 'image') {
    const ik = (parsed as { image_key?: string } | null)?.image_key
    if (ik) keys.push(ik)
  } else if (msgType === 'post') {
    const locale = resolvePostLocale(parsed)
    if (locale) {
      for (const para of locale.content ?? []) {
        for (const node of para) {
          if (node.tag === 'img' && node.image_key) keys.push(node.image_key as string)
        }
      }
    }
  }
  return keys
}

// Extract file_key and file_name from a file message.
export function extractFileInfo(msgType: string, rawContent: string): { fileKey: string; fileName: string } | null {
  if (msgType !== 'file') return null
  let parsed: unknown
  try { parsed = JSON.parse(rawContent) } catch { return null }
  const obj = parsed as { file_key?: string; file_name?: string } | null
  if (!obj?.file_key) return null
  return { fileKey: obj.file_key, fileName: obj.file_name ?? 'unknown' }
}

// lark-cli mget renders file attachments as `<file key="file_xxx" name="name.ext"/>`.
const LARKCLI_FILE_MARKER = /<file\s+key="(file_[A-Za-z0-9_-]+)"\s+name="([^"]+)"\s*\/?>\n?/g
export function extractFileRefsFromRendered(
  content: string,
): { text: string; files: Array<{ fileKey: string; fileName: string }> } {
  const files: Array<{ fileKey: string; fileName: string }> = []
  const stripped = content.replace(LARKCLI_FILE_MARKER, (_, key, name) => {
    files.push({ fileKey: key, fileName: name })
    return ''
  })
  return { text: stripped.replace(/^\n+|\n+$/g, ''), files }
}

const UNSAFE_NAME = /[<>\[\]\r\n;]/g
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(UNSAFE_NAME, '_')
}

// Detect image format from magic bytes. Falls back to octet-stream when
// unrecognized — callers still get a usable file, just with a generic ext.
export function detectImageExt(data: Buffer): { ext: string; mimeType: string } {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { ext: 'png', mimeType: 'image/png' }
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { ext: 'jpg', mimeType: 'image/jpeg' }
  }
  if (data.length >= 6
    && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46
    && data[3] === 0x38 && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) {
    return { ext: 'gif', mimeType: 'image/gif' }
  }
  if (data.length >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return { ext: 'webp', mimeType: 'image/webp' }
  }
  return { ext: 'bin', mimeType: 'application/octet-stream' }
}

// Sanitize a Feishu message_id for filesystem use. Feishu ids already look
// safe (om_xxx hex), but anything outside [A-Za-z0-9_-] gets replaced.
export function safeMessageId(msgId: string): string {
  return msgId.replace(/[^A-Za-z0-9_-]/g, '_')
}

// lark-cli pre-renders image attachments as `[Image: img_xxx]`. Pull those
// out so we can download them separately, and strip the markers from the
// text we show Claude (we'll reattach our own `[image N: /path]` refs).
const LARKCLI_IMAGE_MARKER = /\[Image: (img_[A-Za-z0-9_-]+)\]\n?/g
export function extractImageRefsFromRendered(
  content: string,
): { text: string; imageKeys: string[] } {
  const imageKeys: string[] = []
  const stripped = content.replace(LARKCLI_IMAGE_MARKER, (_, key) => {
    imageKeys.push(key)
    return ''
  })
  return { text: stripped.replace(/^\n+|\n+$/g, ''), imageKeys }
}

// Build the notification body that the channel forwards to Claude. When
// images are present, append `[image N: /path]` refs; if the text was empty,
// use "(image)" so the body is never blank.
export function buildNotificationContent(text: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return text
  const refs = imagePaths.map((p, i) => `\n[image ${i + 1}: ${p}]`).join('')
  return (text || '(image)') + refs
}

// ---------------------------------------------------------------------------
// FeishuClient — SDK wrapper (WSClient for events, Client for REST)
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { Client, WSClient, EventDispatcher, LoggerLevel } from '@larksuiteoapi/node-sdk'
import type { InboundEvent } from './access.ts'

export type FeishuClientOpts = {
  appId: string
  appSecret: string
  domain: string
  loggerLevel?: LoggerLevel
}

export class FeishuClient {
  private client: Client
  private wsClient: WSClient
  private wsRunning = false

  constructor(private opts: FeishuClientOpts) {
    this.client = new Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: opts.domain,
      loggerLevel: opts.loggerLevel ?? LoggerLevel.error,
    })
    this.wsClient = new WSClient({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: opts.domain,
      loggerLevel: opts.loggerLevel ?? LoggerLevel.error,
    })
  }

  // Start the WebSocket loop. Returns once the connection is requested.
  // Reconnects are handled by the SDK; we just log errors through onError.
  subscribe(onEvent: (ev: InboundEvent) => Promise<void> | void, onError?: (e: unknown) => void): void {
    if (this.wsRunning) return
    this.wsRunning = true
    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          await onEvent(data as unknown as InboundEvent)
        } catch (err) {
          onError?.(err)
        }
      },
    })
    // Fire and forget — SDK handles reconnection internally.
    void this.wsClient.start({ eventDispatcher: dispatcher }).catch(err => onError?.(err))
  }

  async sendText(receiveId: string, text: string, receiveIdType: 'chat_id' | 'open_id' = 'chat_id'): Promise<string> {
    const res = await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
    const mid = res?.data?.message_id
    if (!mid) throw new Error('sendText: Feishu API returned no message_id')
    return mid
  }

  async replyText(messageId: string, text: string): Promise<string> {
    const res = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
    const mid = res?.data?.message_id
    if (!mid) throw new Error('replyText: Feishu API returned no message_id')
    return mid
  }

  // Fetch a message's pre-rendered content via lark-cli mget. lark-cli flattens
  // Feishu's format zoo (post variants, merge_forward, sticker, etc.) into a
  // single human-readable string — saves us from maintaining a parser per
  // msg_type. Caller handles image extraction separately.
  fetchRenderedMessage(messageId: string): { content: string; msgType: string } {
    let out: string
    try {
      out = execFileSync(
        'lark-cli',
        ['im', '+messages-mget', '--as', 'bot', '--message-ids', messageId, '--format', 'json'],
        { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
      )
    } catch (err) {
      throw new Error(`fetchRenderedMessage: lark-cli failed: ${err}`)
    }
    let parsed: unknown
    try { parsed = JSON.parse(out) } catch {
      throw new Error('fetchRenderedMessage: lark-cli output is not JSON')
    }
    const msg = (parsed as { data?: { messages?: Array<{ content?: string; msg_type?: string }> } })
      ?.data?.messages?.[0]
    if (!msg) throw new Error('fetchRenderedMessage: message not found in response')
    return { content: String(msg.content ?? ''), msgType: String(msg.msg_type ?? 'unknown') }
  }

  // Download a file via lark-cli. Preserves the original filename.
  downloadFile(
    messageId: string,
    fileKey: string,
    destDir: string,
    fileName: string,
  ): string {
    mkdirSync(destDir, { recursive: true })
    const safeFn = fileName.replace(/[^A-Za-z0-9._-]/g, '_')
    try {
      execFileSync(
        'lark-cli',
        ['im', '+messages-resources-download', '--as', 'bot', '--message-id', messageId, '--file-key', fileKey, '--type', 'file', '--output', safeFn],
        { cwd: destDir, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
      )
    } catch (err) {
      throw new Error(`downloadFile: lark-cli failed: ${err}`)
    }
    return join(destDir, safeFn)
  }

  // Send a file via lark-cli.
  sendFile(chatId: string, filePath: string): string {
    const out = execFileSync(
      'lark-cli',
      ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--file', basename(filePath)],
      { encoding: 'utf8', timeout: 60000, cwd: dirname(filePath) },
    )
    const mid = JSON.parse(out)?.data?.message_id
    if (!mid) throw new Error('sendFile: no message_id in lark-cli output')
    return mid
  }

  // Reply with a file via lark-cli.
  replyFile(messageId: string, filePath: string): string {
    const out = execFileSync(
      'lark-cli',
      ['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, '--file', basename(filePath)],
      { encoding: 'utf8', timeout: 60000, cwd: dirname(filePath) },
    )
    const mid = JSON.parse(out)?.data?.message_id
    if (!mid) throw new Error('replyFile: no message_id in lark-cli output')
    return mid
  }

  // Send markdown via lark-cli (auto-wrapped as post with style optimization).
  sendMarkdown(chatId: string, markdown: string): string {
    const out = execFileSync(
      'lark-cli',
      ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--markdown', markdown],
      { encoding: 'utf8', timeout: 30000 },
    )
    const mid = JSON.parse(out)?.data?.message_id
    if (!mid) throw new Error('sendMarkdown: no message_id in lark-cli output')
    return mid
  }

  // Reply with markdown via lark-cli.
  replyMarkdown(messageId: string, markdown: string): string {
    const out = execFileSync(
      'lark-cli',
      ['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, '--markdown', markdown],
      { encoding: 'utf8', timeout: 30000 },
    )
    const mid = JSON.parse(out)?.data?.message_id
    if (!mid) throw new Error('replyMarkdown: no message_id in lark-cli output')
    return mid
  }

  // Download an image via lark-cli and persist it under destDir with a proper
  // extension sniffed from magic bytes. Returns the absolute path + mimeType.
  // Caller owns the file — we do not auto-delete.
  downloadImage(
    messageId: string,
    imageKey: string,
    destDir: string,
    basename: string,
  ): { path: string; mimeType: string } {
    mkdirSync(destDir, { recursive: true })
    const tmpFile = `${basename}.part`
    try {
      execFileSync(
        'lark-cli',
        ['im', '+messages-resources-download', '--as', 'bot', '--message-id', messageId, '--file-key', imageKey, '--type', 'image', '--output', tmpFile],
        { cwd: destDir, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
      )
    } catch (err) {
      throw new Error(`downloadImage: lark-cli failed: ${err}`)
    }
    const tmpPath = join(destDir, tmpFile)
    const data = readFileSync(tmpPath)
    const { ext, mimeType } = detectImageExt(data)
    const finalPath = join(destDir, `${basename}.${ext}`)
    try { renameSync(tmpPath, finalPath) } catch {
      // fall back: leave the .part file and return its path
      return { path: tmpPath, mimeType }
    }
    return { path: finalPath, mimeType }
  }

  // Send an image via lark-cli (handles upload internally). lark-cli rejects
  // absolute --image paths, so we cd into the file's directory and pass basename.
  sendImage(chatId: string, imagePath: string): string {
    const out = execFileSync(
      'lark-cli',
      ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--image', basename(imagePath)],
      { encoding: 'utf8', timeout: 30000, cwd: dirname(imagePath) },
    )
    const mid = JSON.parse(out)?.data?.message_id
    if (!mid) throw new Error('sendImage: no message_id in lark-cli output')
    return mid
  }

  replyImage(messageId: string, imagePath: string): string {
    const out = execFileSync(
      'lark-cli',
      ['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, '--image', basename(imagePath)],
      { encoding: 'utf8', timeout: 30000, cwd: dirname(imagePath) },
    )
    const mid = JSON.parse(out)?.data?.message_id
    if (!mid) throw new Error('replyImage: no message_id in lark-cli output')
    return mid
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    const res = await this.client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    })
    const rid = (res?.data as any)?.reaction_id
    if (!rid) throw new Error('addReaction: no reaction_id returned')
    return rid
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await this.client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    })
  }

  async close(): Promise<void> {
    this.wsRunning = false
    this.wsClient.close()
  }
}
