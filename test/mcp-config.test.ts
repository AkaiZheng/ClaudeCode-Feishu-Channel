import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, sep } from 'node:path'
import { buildMcpConfig, writeMcpConfig } from '../src/mcp-config.ts'

describe('buildMcpConfig', () => {
  test('uses the provided bun path verbatim as command', () => {
    const c = buildMcpConfig({ bunPath: '/opt/bun/bin/bun', projectDir: '/repo' })
    expect(c.mcpServers.feishu!.command).toBe('/opt/bun/bin/bun')
  })

  test('args is exactly one absolute path to src/server.ts', () => {
    const c = buildMcpConfig({ bunPath: '/x/bun', projectDir: '/home/me/repo' })
    expect(c.mcpServers.feishu!.args).toEqual([join('/home/me/repo', 'src', 'server.ts')])
    expect(c.mcpServers.feishu!.args.length).toBe(1)
    expect(isAbsolute(c.mcpServers.feishu!.args[0]!)).toBe(true)
  })

  test('cwd is the resolved absolute project dir', () => {
    const c = buildMcpConfig({ bunPath: '/x/bun', projectDir: '/home/me/repo' })
    expect(c.mcpServers.feishu!.cwd).toBe('/home/me/repo')
    expect(isAbsolute(c.mcpServers.feishu!.cwd)).toBe(true)
  })

  test('relative project dir collapses to absolute via resolve', () => {
    const c = buildMcpConfig({ bunPath: '/x/bun', projectDir: '.' })
    expect(isAbsolute(c.mcpServers.feishu!.cwd)).toBe(true)
    expect(isAbsolute(c.mcpServers.feishu!.args[0]!)).toBe(true)
  })

  test('trailing-dot path segments are normalized', () => {
    const c = buildMcpConfig({ bunPath: '/x/bun', projectDir: '/home/me/repo/scripts/..' })
    expect(c.mcpServers.feishu!.cwd).toBe('/home/me/repo')
  })

  test('shape matches Claude Code .mcp.json schema (command/args/cwd)', () => {
    const c = buildMcpConfig({ bunPath: '/x/bun', projectDir: '/repo' })
    expect(Object.keys(c)).toEqual(['mcpServers'])
    expect(Object.keys(c.mcpServers)).toEqual(['feishu'])
    expect(Object.keys(c.mcpServers.feishu!).sort()).toEqual(['args', 'command', 'cwd'])
  })

  test('args path uses platform-native separators', () => {
    const c = buildMcpConfig({ bunPath: '/x/bun', projectDir: '/repo' })
    // join() produces platform separators; the segment between repo and src
    // must contain the platform sep regardless of input style.
    expect(c.mcpServers.feishu!.args[0]).toContain(`src${sep}server.ts`)
  })
})

describe('writeMcpConfig', () => {
  test('writes parseable JSON with absolute paths and trailing newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-config-'))
    try {
      const path = writeMcpConfig({ bunPath: '/x/bun', projectDir: dir })
      expect(path).toBe(join(dir, '.mcp.json'))
      const raw = readFileSync(path, 'utf8')
      expect(raw.endsWith('\n')).toBe(true)
      const parsed = JSON.parse(raw)
      expect(parsed.mcpServers.feishu.command).toBe('/x/bun')
      expect(parsed.mcpServers.feishu.cwd).toBe(dir)
      expect(parsed.mcpServers.feishu.args).toEqual([join(dir, 'src', 'server.ts')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('respects custom outputPath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-config-'))
    try {
      const out = join(dir, 'custom.json')
      const written = writeMcpConfig({ bunPath: '/x/bun', projectDir: dir, outputPath: out })
      expect(written).toBe(out)
      const parsed = JSON.parse(readFileSync(out, 'utf8'))
      expect(parsed.mcpServers.feishu.command).toBe('/x/bun')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('overwrites an existing .mcp.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-config-'))
    try {
      writeMcpConfig({ bunPath: '/old/bun', projectDir: dir })
      writeMcpConfig({ bunPath: '/new/bun', projectDir: dir })
      const parsed = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
      expect(parsed.mcpServers.feishu.command).toBe('/new/bun')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
