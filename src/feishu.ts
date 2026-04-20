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
    const payload = (parsed ?? {}) as PostPayload
    const locale = payload.zh_cn ?? payload.en_us ?? Object.values(payload)[0]
    if (!locale) return ''
    const lines: string[] = []
    if (locale.title) lines.push(locale.title)
    for (const para of locale.content ?? []) {
      const parts = para.map(renderNode).filter(Boolean)
      lines.push(parts.join(''))
    }
    return lines.filter(l => l.length > 0).join('\n\n')
  }
  if (msgType === 'image') return '(image)'
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

const UNSAFE_NAME = /[<>\[\]\r\n;]/g
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(UNSAFE_NAME, '_')
}

// ---------------------------------------------------------------------------
// FeishuClient — SDK wrapper (WSClient for events, Client for REST)
// ---------------------------------------------------------------------------

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
