import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

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
