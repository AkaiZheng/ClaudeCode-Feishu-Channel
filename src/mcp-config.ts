import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type McpServerConfig = {
  command: string
  args: string[]
  cwd: string
}

export type McpConfig = {
  mcpServers: Record<string, McpServerConfig>
}

// Build a project-level .mcp.json payload with absolute paths so Claude Code's
// harness can spawn the server regardless of PATH or working directory.
//
// `bunPath` should be an absolute path to the bun binary (in scripts that run
// under bun, `process.execPath` is the canonical source). `projectDir` is the
// repo root; we resolve it so a relative caller path collapses to absolute.
export function buildMcpConfig(opts: {
  bunPath: string
  projectDir: string
}): McpConfig {
  const projectDir = resolve(opts.projectDir)
  return {
    mcpServers: {
      feishu: {
        command: opts.bunPath,
        args: [join(projectDir, 'src', 'server.ts')],
        cwd: projectDir,
      },
    },
  }
}

export function writeMcpConfig(opts: {
  bunPath: string
  projectDir: string
  outputPath?: string
}): string {
  const config = buildMcpConfig(opts)
  const projectDir = resolve(opts.projectDir)
  const path = opts.outputPath ?? join(projectDir, '.mcp.json')
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  return path
}
