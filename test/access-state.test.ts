import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultAccess, readAccessFile, saveAccess } from '../src/access.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'feishu-acc-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('defaultAccess', () => {
  test('produces a valid empty Access', () => {
    const a = defaultAccess()
    expect(a.dmPolicy).toBe('pairing')
    expect(a.allowFrom).toEqual([])
    expect(a.allowChats).toEqual([])
    expect(a.groups).toEqual({})
    expect(a.pending).toEqual({})
  })
})

describe('readAccessFile', () => {
  test('returns default when file is missing', () => {
    const a = readAccessFile(join(dir, 'access.json'))
    expect(a).toEqual(defaultAccess())
  })

  test('parses a well-formed file', () => {
    const file = join(dir, 'access.json')
    writeFileSync(file, JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['ou_a'],
      groups: {},
      pending: {},
    }))
    const a = readAccessFile(file)
    expect(a.dmPolicy).toBe('allowlist')
    expect(a.allowFrom).toEqual(['ou_a'])
  })

  test('missing fields are filled with defaults', () => {
    const file = join(dir, 'access.json')
    writeFileSync(file, JSON.stringify({ allowFrom: ['ou_a'] }))
    const a = readAccessFile(file)
    expect(a.dmPolicy).toBe('pairing')
    expect(a.allowFrom).toEqual(['ou_a'])
    expect(a.groups).toEqual({})
  })

  test('corrupt JSON is renamed aside and defaults are returned', () => {
    const file = join(dir, 'access.json')
    writeFileSync(file, 'not json')
    const a = readAccessFile(file)
    expect(a).toEqual(defaultAccess())
    const siblings = readdirSync(dir)
    const corrupt = siblings.find(n => n.startsWith('access.json.corrupt-'))
    expect(corrupt).toBeDefined()
  })
})

describe('saveAccess', () => {
  test('writes atomically with 0o600 perms', () => {
    const file = join(dir, 'access.json')
    const a = defaultAccess()
    a.allowFrom = ['ou_xyz']
    saveAccess(file, a)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.allowFrom).toEqual(['ou_xyz'])
    const stat = statSync(file)
    // low 9 bits = rwx rwx rwx; 0o600 = owner rw only
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test('roundtrip via read→save→read is stable', () => {
    const file = join(dir, 'access.json')
    const a = defaultAccess()
    a.allowFrom = ['ou_1', 'ou_2']
    a.allowChats = ['oc_1', 'oc_2']
    a.dmPolicy = 'allowlist'
    saveAccess(file, a)
    const b = readAccessFile(file)
    expect(b.allowFrom).toEqual(['ou_1', 'ou_2'])
    expect(b.allowChats).toEqual(['oc_1', 'oc_2'])
    expect(b.dmPolicy).toBe('allowlist')
  })
})
