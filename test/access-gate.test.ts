import { describe, expect, test } from 'bun:test'
import { defaultAccess, gate, type InboundEvent } from '../src/access.ts'

const now = 1_700_000_000_000

const ev = (over: Partial<{
  openId: string
  chatId: string
  chatType: 'p2p' | 'group'
  mentioned: boolean
  createTime: number
}> = {}): InboundEvent => ({
  sender: { open_id: over.openId ?? 'ou_new' },
  message: {
    chat_id: over.chatId ?? 'oc_default',
    chat_type: over.chatType ?? 'p2p',
    message_id: 'om_1',
    content: '{"text":"hi"}',
    create_time: String(over.createTime ?? now),
    mentions: over.mentioned ? [{ key: '@_user_1', name: 'feishu-bot', id: { open_id: 'ou_bot' } }] : [],
  },
})

describe('gate — DM policies', () => {
  test('disabled policy drops everything', () => {
    const a = defaultAccess(); a.dmPolicy = 'disabled'
    expect(gate(ev(), a, now).action).toBe('drop')
  })

  test('allowlisted sender delivers regardless of policy', () => {
    const a = defaultAccess(); a.allowFrom = ['ou_friend']
    expect(gate(ev({ openId: 'ou_friend' }), a, now).action).toBe('deliver')
  })

  test('allowlist policy + non-member drops', () => {
    const a = defaultAccess(); a.dmPolicy = 'allowlist'
    expect(gate(ev(), a, now).action).toBe('drop')
  })

  test('pairing policy + first-time sender → pair(new code, isResend=false)', () => {
    const a = defaultAccess()
    const r = gate(ev({ openId: 'ou_new', chatId: 'oc_new' }), a, now)
    expect(r.action).toBe('pair')
    if (r.action !== 'pair') throw new Error()
    expect(r.isResend).toBe(false)
    expect(r.code).toMatch(/^[a-f0-9]{6}$/)
    expect(r.nextAccess.pending[r.code]!.senderId).toBe('ou_new')
    expect(r.nextAccess.pending[r.code]!.chatId).toBe('oc_new')
    expect(r.nextAccess.pending[r.code]!.replies).toBe(1)
    expect(r.nextAccess.pending[r.code]!.expiresAt).toBe(now + 60 * 60 * 1000)
  })

  test('pairing policy + repeat sender → pair(same code, isResend=true, replies++)', () => {
    const a = defaultAccess()
    a.pending['abc123'] = { senderId: 'ou_x', chatId: 'oc_x', createdAt: now, expiresAt: now + 3600000, replies: 1 }
    const r = gate(ev({ openId: 'ou_x' }), a, now + 1)
    expect(r.action).toBe('pair')
    if (r.action !== 'pair') throw new Error()
    expect(r.code).toBe('abc123')
    expect(r.isResend).toBe(true)
    expect(r.nextAccess.pending['abc123']!.replies).toBe(2)
  })

  test('pairing policy + third pending reminder from same sender → drop', () => {
    const a = defaultAccess()
    a.pending['abc123'] = { senderId: 'ou_x', chatId: 'oc_x', createdAt: now, expiresAt: now + 3600000, replies: 2 }
    expect(gate(ev({ openId: 'ou_x' }), a, now).action).toBe('drop')
  })

  test('pairing policy + pending saturated (3 entries, new sender) → drop', () => {
    const a = defaultAccess()
    for (let i = 0; i < 3; i++) {
      a.pending[`code${i}`] = { senderId: `ou_${i}`, chatId: `oc_${i}`, createdAt: now, expiresAt: now + 3600000, replies: 1 }
    }
    expect(gate(ev({ openId: 'ou_new' }), a, now).action).toBe('drop')
  })

  test('expired pending is pruned and no longer counted', () => {
    const a = defaultAccess()
    a.pending['old'] = { senderId: 'ou_old', chatId: 'oc_old', createdAt: 0, expiresAt: now - 1, replies: 1 }
    const r = gate(ev({ openId: 'ou_new' }), a, now)
    expect(r.action).toBe('pair')
    if (r.action !== 'pair') throw new Error()
    expect(r.nextAccess.pending.old).toBeUndefined()
  })

  test('missing sender open_id drops', () => {
    const a = defaultAccess()
    const event: InboundEvent = {
      sender: { open_id: '' },
      message: { chat_id: 'oc_x', chat_type: 'p2p', message_id: 'om', content: '{}', create_time: '0', mentions: [] },
    }
    expect(gate(event, a, now).action).toBe('drop')
  })
})

describe('gate — group chat', () => {
  test('group without policy → drop', () => {
    const a = defaultAccess()
    expect(gate(ev({ chatType: 'group', chatId: 'oc_g' }), a, now).action).toBe('drop')
  })

  test('group with policy, mention required, not mentioned → drop', () => {
    const a = defaultAccess()
    a.groups['oc_g'] = { requireMention: true, allowFrom: [] }
    expect(gate(ev({ chatType: 'group', chatId: 'oc_g', mentioned: false }), a, now).action).toBe('drop')
  })

  test('group with policy, mention required, mentioned → deliver', () => {
    const a = defaultAccess()
    a.groups['oc_g'] = { requireMention: true, allowFrom: [] }
    expect(gate(ev({ chatType: 'group', chatId: 'oc_g', mentioned: true }), a, now).action).toBe('deliver')
  })

  test('group allowFrom restricts sender', () => {
    const a = defaultAccess()
    a.groups['oc_g'] = { requireMention: false, allowFrom: ['ou_ok'] }
    expect(gate(ev({ chatType: 'group', chatId: 'oc_g', openId: 'ou_nope' }), a, now).action).toBe('drop')
    expect(gate(ev({ chatType: 'group', chatId: 'oc_g', openId: 'ou_ok' }), a, now).action).toBe('deliver')
  })
})
