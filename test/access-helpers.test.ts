import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultAccess, assertAllowedChat, readApprovals, removeApproval } from '../src/access.ts'

describe('assertAllowedChat', () => {
  test('throws for non-allowlisted chat', () => {
    expect(() => assertAllowedChat(defaultAccess(), 'oc_rando')).toThrow(/not allowlisted/)
  })

  test('accepts allowlisted open_id (P2P chat_id == open_id semantics)', () => {
    const a = defaultAccess(); a.allowFrom = ['oc_friend']
    expect(() => assertAllowedChat(a, 'oc_friend')).not.toThrow()
  })

  test('accepts group chat_id that is in groups map', () => {
    const a = defaultAccess()
    a.groups['oc_group'] = { requireMention: true, allowFrom: [] }
    expect(() => assertAllowedChat(a, 'oc_group')).not.toThrow()
  })
})

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'feishu-apv-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('readApprovals / removeApproval', () => {
  test('empty dir returns []', () => {
    expect(readApprovals(tmp)).toEqual([])
  })

  test('returns one entry per file in approved/', () => {
    mkdirSync(join(tmp, 'approved'), { recursive: true })
    writeFileSync(join(tmp, 'approved', 'ou_a'), '')
    writeFileSync(join(tmp, 'approved', 'ou_b'), '')
    const got = readApprovals(tmp).sort()
    expect(got).toEqual(['ou_a', 'ou_b'])
  })

  test('removeApproval deletes the file', () => {
    mkdirSync(join(tmp, 'approved'), { recursive: true })
    writeFileSync(join(tmp, 'approved', 'ou_a'), '')
    removeApproval(tmp, 'ou_a')
    expect(existsSync(join(tmp, 'approved', 'ou_a'))).toBe(false)
  })

  test('removeApproval on missing file does not throw', () => {
    expect(() => removeApproval(tmp, 'ou_nope')).not.toThrow()
  })

  test('approved dir missing → readApprovals returns []', () => {
    // no mkdirSync — tmp/approved doesn't exist
    expect(readApprovals(tmp)).toEqual([])
  })
})
