import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDotEnv, resolveStateDir } from '../src/config.ts'

let tmp: string
const snapshotKeys = ['FOO', 'BAR', 'BAZ', 'FEISHU_APP_ID', 'FEISHU_STATE_DIR']
const snapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'feishu-cfg-'))
  for (const k of snapshotKeys) snapshot[k] = process.env[k]
  for (const k of snapshotKeys) delete process.env[k]
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  for (const k of snapshotKeys) {
    if (snapshot[k] === undefined) delete process.env[k]
    else process.env[k] = snapshot[k]
  }
})

describe('loadDotEnv', () => {
  test('populates process.env for KEY=VALUE lines', () => {
    const p = join(tmp, '.env')
    writeFileSync(p, 'FOO=one\nBAR=two\n')
    loadDotEnv(p)
    expect(process.env.FOO).toBe('one')
    expect(process.env.BAR).toBe('two')
  })

  test('does not overwrite already-set env vars', () => {
    process.env.FOO = 'live'
    const p = join(tmp, '.env')
    writeFileSync(p, 'FOO=file\n')
    loadDotEnv(p)
    expect(process.env.FOO).toBe('live')
  })

  test('skips blank lines and # comments', () => {
    const p = join(tmp, '.env')
    writeFileSync(p, '# header\n\nBAZ=three\n# trailing\n')
    loadDotEnv(p)
    expect(process.env.BAZ).toBe('three')
  })

  test('missing file is a no-op (not an error)', () => {
    expect(() => loadDotEnv(join(tmp, 'nope'))).not.toThrow()
  })

  test('values can contain =', () => {
    const p = join(tmp, '.env')
    writeFileSync(p, 'FOO=a=b=c\n')
    loadDotEnv(p)
    expect(process.env.FOO).toBe('a=b=c')
  })
})

describe('resolveStateDir', () => {
  test('defaults to ~/.claude/channels/feishu', () => {
    const dir = resolveStateDir('/home/me')
    expect(dir).toBe('/home/me/.claude/channels/feishu')
  })

  test('FEISHU_STATE_DIR overrides', () => {
    process.env.FEISHU_STATE_DIR = '/tmp/override-feishu'
    expect(resolveStateDir('/home/me')).toBe('/tmp/override-feishu')
  })
})
