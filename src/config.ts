import { readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

// Load KEY=VALUE lines into process.env. Missing file is a no-op.
// Lines starting with # and blank lines are skipped. Real env wins — we
// never overwrite a value that is already present. Called before the
// channel validates required FEISHU_* vars, so the operator can set
// overrides via shell env without editing .env.
export function loadDotEnv(path: string): void {
  let raw: string
  try {
    chmodSync(path, 0o600) // best-effort tighten; no-op on Windows
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export function resolveStateDir(home: string): string {
  const override = process.env.FEISHU_STATE_DIR
  if (override && override.length > 0) return override
  return join(home, '.claude', 'channels', 'feishu')
}
