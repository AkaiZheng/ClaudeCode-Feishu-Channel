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

// Appended to src/config.ts — keep existing exports.

export type LarkCliImport = {
  env: Partial<Record<'FEISHU_APP_ID' | 'FEISHU_APP_SECRET' | 'FEISHU_USER_OPEN_ID', string>>
  brand?: 'feishu' | 'lark'
  /** 'plaintext' if the secret came through, 'keychain' if we saw a reference-only entry, undefined if no app. */
  secretSource?: 'plaintext' | 'keychain' | 'missing'
  /** Human-readable reason when env is empty — for logging. */
  reason?: string
}

type LarkCliConfigFile = {
  apps?: Array<{
    appId?: string
    appSecret?: string | { source?: string; id?: string }
    brand?: string
    users?: Array<{ userOpenId?: string; userName?: string }>
  }>
}

// Best-effort: read ~/.lark-cli/config.json. Extract appId, userOpenId, brand.
// If appSecret is stored inline (plaintext), return it too; if it is a
// keychain reference, the caller must source the secret another way.
export function importFromLarkCli(home: string): LarkCliImport {
  const path = join(home, '.lark-cli', 'config.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { env: {}, reason: `${path} not found` }
    }
    return { env: {}, reason: `failed to read ${path}: ${err}` }
  }
  let parsed: LarkCliConfigFile
  try {
    parsed = JSON.parse(raw) as LarkCliConfigFile
  } catch (err) {
    return { env: {}, reason: `failed to parse ${path}: ${err}` }
  }
  const apps = parsed.apps ?? []
  const app = apps[0]
  if (!app) return { env: {}, reason: 'no apps[] in lark-cli config' }

  const env: LarkCliImport['env'] = {}
  if (app.appId) env.FEISHU_APP_ID = app.appId
  const firstUser = app.users?.[0]
  if (firstUser?.userOpenId) env.FEISHU_USER_OPEN_ID = firstUser.userOpenId

  let secretSource: LarkCliImport['secretSource'] = 'missing'
  if (typeof app.appSecret === 'string') {
    env.FEISHU_APP_SECRET = app.appSecret
    secretSource = 'plaintext'
  } else if (app.appSecret && typeof app.appSecret === 'object' && app.appSecret.source === 'keychain') {
    secretSource = 'keychain'
  }

  const brand: 'feishu' | 'lark' | undefined =
    app.brand === 'lark' || app.brand === 'feishu' ? app.brand : undefined

  return brand !== undefined
    ? { env, brand, secretSource }
    : { env, secretSource }
}

export function resolveDomain(brand: string | undefined): string {
  return brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}
