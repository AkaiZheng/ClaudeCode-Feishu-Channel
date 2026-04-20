import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  allowChats: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  textChunkLimit?: number
  replyToMode?: 'off' | 'first' | 'all'
}

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    allowChats: [],
    groups: {},
    pending: {},
  }
}

export function readAccessFile(path: string): Access {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      allowChats: parsed.allowChats ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      ...(parsed.mentionPatterns ? { mentionPatterns: parsed.mentionPatterns } : {}),
      ...(parsed.ackReaction ? { ackReaction: parsed.ackReaction } : {}),
      ...(parsed.textChunkLimit != null ? { textChunkLimit: parsed.textChunkLimit } : {}),
      ...(parsed.replyToMode ? { replyToMode: parsed.replyToMode } : {}),
    }
  } catch {
    // Corrupt file — rename aside so we don't clobber whatever the operator
    // hand-edited, and fall back to defaults. Parallel sessions would both
    // detect this on startup; the single-instance lock prevents concurrent
    // writes at runtime, so this branch only fires at boot.
    try { renameSync(path, `${path}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`feishu channel: ${path} was corrupt — moved aside, starting fresh.\n`)
    return defaultAccess()
  }
}

export function saveAccess(path: string, access: Access): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  // Belt-and-suspenders: renameSync preserves the tmp's perms, but explicit
  // chmod makes the invariant visible if someone edits this later.
  try { chmodSync(path, 0o600) } catch {}
}

// Appended to src/access.ts — keep existing exports.

export type InboundEvent = {
  sender: {
    sender_id: { open_id: string; union_id?: string; user_id?: string | null }
    sender_type: string
    tenant_key?: string
  }
  message: {
    chat_id: string
    chat_type: 'p2p' | 'group' | string
    message_id: string
    message_type: string
    content: string
    create_time?: string
    mentions?: Array<{ key?: string; name?: string; id?: { open_id?: string; union_id?: string; user_id?: string } }>
  }
}

/** Helper to get sender open_id from the nested event structure */
export function getSenderOpenId(event: InboundEvent): string | undefined {
  return event.sender?.sender_id?.open_id
}

export type GateResult =
  | { action: 'deliver' }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean; nextAccess: Access; chatId: string }

const PAIRING_TTL_MS = 60 * 60 * 1000
const PAIRING_MAX_REPLIES = 2
const PAIRING_MAX_PENDING = 3

function pruneExpired(a: Access, now: number): Access {
  let changed = false
  const next: Record<string, PendingEntry> = {}
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { changed = true; continue }
    next[code] = p
  }
  return changed ? { ...a, pending: next } : a
}

function isMentioned(event: InboundEvent, botOpenId?: string, extraPatterns?: string[]): boolean {
  // Feishu puts explicit @-mentions in message.mentions. A mention of the bot
  // has id.open_id matching the bot's own open_id. When botOpenId is not known
  // (P0 shortcut: the bot's own open_id is resolved in P1), any mention is
  // treated as sufficient. Callers must pass `undefined` when they don't have
  // the bot's open_id — passing the app_id (`cli_xxx`) would never match.
  // We also accept user-supplied regex patterns against the content for workflows
  // like keyword-triggers.
  if (event.message.mentions && event.message.mentions.length > 0) {
    if (!botOpenId) return true
    for (const m of event.message.mentions) {
      if (m.id?.open_id === botOpenId) return true
    }
  }
  const parsed = safeParseContent(event.message.content)
  const text = typeof parsed === 'object' && parsed && 'text' in parsed ? String((parsed as { text: unknown }).text ?? '') : ''
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
  }
  return false
}

function safeParseContent(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return {} }
}

export function gate(event: InboundEvent, access: Access, now: number, botOpenId?: string): GateResult {
  const pruned = pruneExpired(access, now)
  if (pruned.dmPolicy === 'disabled') return { action: 'drop' }
  const sender = getSenderOpenId(event)
  if (!sender) return { action: 'drop' }
  const chatId = event.message.chat_id
  const chatType = event.message.chat_type

  if (chatType === 'p2p') {
    if (pruned.allowFrom.includes(sender)) return { action: 'deliver' }
    if (pruned.dmPolicy === 'allowlist') return { action: 'drop' }

    // pairing mode
    for (const [code, p] of Object.entries(pruned.pending)) {
      if (p.senderId === sender) {
        if (p.replies >= PAIRING_MAX_REPLIES) return { action: 'drop' }
        const next: Access = {
          ...pruned,
          pending: { ...pruned.pending, [code]: { ...p, replies: p.replies + 1 } },
        }
        return { action: 'pair', code, isResend: true, nextAccess: next, chatId }
      }
    }
    if (Object.keys(pruned.pending).length >= PAIRING_MAX_PENDING) return { action: 'drop' }
    const code = randomBytes(3).toString('hex')
    const entry: PendingEntry = {
      senderId: sender,
      chatId,
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      replies: 1,
    }
    const next: Access = { ...pruned, pending: { ...pruned.pending, [code]: entry } }
    return { action: 'pair', code, isResend: false, nextAccess: next, chatId }
  }

  if (chatType === 'group') {
    const policy = pruned.groups[chatId]
    if (!policy) return { action: 'drop' }
    if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(sender)) return { action: 'drop' }
    if (policy.requireMention && !isMentioned(event, botOpenId, pruned.mentionPatterns)) return { action: 'drop' }
    return { action: 'deliver' }
  }

  return { action: 'drop' }
}

// Outbound gate — reply/react/edit can only target chats the inbound gate
// would deliver from. P2P DMs are gated on allowChats (chat_ids, oc_xxx),
// which is distinct from allowFrom (open_ids, ou_xxx) — Feishu never aliases
// them. Groups are accepted if they are in the groups map (the operator has
// explicitly opted that group in).
export function assertAllowedChat(access: Access, chatId: string): void {
  if (access.allowChats.includes(chatId)) return
  if (chatId in access.groups) return
  throw new Error(`chat ${chatId} is not allowlisted — add via /feishu:access`)
}

export function readApprovals(stateDir: string): string[] {
  const dir = join(stateDir, 'approved')
  try {
    return readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

export function removeApproval(stateDir: string, openId: string): void {
  const file = join(stateDir, 'approved', openId)
  try { rmSync(file, { force: true }) } catch {}
}
