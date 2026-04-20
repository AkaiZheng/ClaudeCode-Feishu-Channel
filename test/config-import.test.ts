import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importFromLarkCli, resolveDomain } from '../src/config.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'feishu-import-'))
  mkdirSync(join(home, '.lark-cli'), { recursive: true })
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('importFromLarkCli', () => {
  test('extracts appId, brand, userOpenId from live layout', () => {
    writeFileSync(
      join(home, '.lark-cli', 'config.json'),
      JSON.stringify({
        apps: [{
          appId: 'cli_test',
          appSecret: { source: 'keychain', id: 'appsecret:cli_test' },
          brand: 'feishu',
          users: [{ userOpenId: 'ou_abc', userName: 'Tester' }],
        }],
      }),
    )
    const imported = importFromLarkCli(home)
    expect(imported.env.FEISHU_APP_ID).toBe('cli_test')
    expect(imported.env.FEISHU_USER_OPEN_ID).toBe('ou_abc')
    expect(imported.brand).toBe('feishu')
    expect(imported.env.FEISHU_APP_SECRET).toBeUndefined()
    expect(imported.secretSource).toBe('keychain')
  })

  test('returns plaintext secret when lark-cli stores it inline', () => {
    writeFileSync(
      join(home, '.lark-cli', 'config.json'),
      JSON.stringify({
        apps: [{
          appId: 'cli_test',
          appSecret: 'plain-secret-value',
          brand: 'lark',
          users: [{ userOpenId: 'ou_xyz', userName: 'X' }],
        }],
      }),
    )
    const imported = importFromLarkCli(home)
    expect(imported.env.FEISHU_APP_SECRET).toBe('plain-secret-value')
    expect(imported.env.FEISHU_APP_ID).toBe('cli_test')
    expect(imported.brand).toBe('lark')
    expect(imported.secretSource).toBe('plaintext')
  })

  test('missing config.json returns empty result', () => {
    const imported = importFromLarkCli(home)
    expect(imported.env).toEqual({})
    expect(imported.reason).toContain('not found')
  })

  test('corrupt config.json returns empty result with reason', () => {
    writeFileSync(join(home, '.lark-cli', 'config.json'), 'not json at all')
    const imported = importFromLarkCli(home)
    expect(imported.env).toEqual({})
    expect(imported.reason).toContain('parse')
  })

  test('empty apps[] returns empty result', () => {
    writeFileSync(
      join(home, '.lark-cli', 'config.json'),
      JSON.stringify({ apps: [] }),
    )
    const imported = importFromLarkCli(home)
    expect(imported.env).toEqual({})
    expect(imported.reason).toContain('no apps')
  })

  test('missing users[] still returns appId', () => {
    writeFileSync(
      join(home, '.lark-cli', 'config.json'),
      JSON.stringify({
        apps: [{
          appId: 'cli_no_user',
          appSecret: { source: 'keychain', id: 'x' },
          brand: 'feishu',
          users: [],
        }],
      }),
    )
    const imported = importFromLarkCli(home)
    expect(imported.env.FEISHU_APP_ID).toBe('cli_no_user')
    expect(imported.env.FEISHU_USER_OPEN_ID).toBeUndefined()
  })
})

describe('resolveDomain', () => {
  test('feishu → open.feishu.cn', () => {
    expect(resolveDomain('feishu')).toBe('https://open.feishu.cn')
  })
  test('lark → open.larksuite.com', () => {
    expect(resolveDomain('lark')).toBe('https://open.larksuite.com')
  })
  test('undefined → feishu default', () => {
    expect(resolveDomain(undefined)).toBe('https://open.feishu.cn')
  })
  test('unknown brand → feishu default (with warning-safe fallback)', () => {
    expect(resolveDomain('nope')).toBe('https://open.feishu.cn')
  })
})
