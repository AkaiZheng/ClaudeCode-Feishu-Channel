#!/usr/bin/env bun
// Regenerate .mcp.json with absolute paths so Claude Code can launch the
// MCP server even when bun isn't on PATH and the harness uses a different
// working directory. Called from install.sh after `bun install` and from
// scripts/setup.ts during interactive setup.
import { resolve } from 'node:path'
import { writeMcpConfig } from '../src/mcp-config.ts'

const projectDir = resolve(import.meta.dir, '..')
const bunPath = process.execPath

const out = writeMcpConfig({ bunPath, projectDir })
console.log(`✓ Wrote ${out}`)
console.log(`  command: ${bunPath}`)
console.log(`  cwd:     ${projectDir}`)
