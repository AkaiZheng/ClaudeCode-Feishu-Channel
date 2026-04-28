import { readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'


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

// ---------------------------------------------------------------------------
// lark-cli keychain decryption — extract app secret from lark-cli's encrypted
// store without user interaction.
//
// lark-cli stores secrets as AES-256-GCM encrypted files:
//   nonce(12 bytes) + ciphertext(N bytes) + tag(16 bytes)
//
// The 32-byte master key lives in different places per platform:
//   Linux:  ~/.local/share/lark-cli/master.key  (plain file)
//   macOS:  macOS Keychain, service="lark-cli"   (via `security` CLI)
//   Windows: TODO — needs investigation
//
// Encrypted files (.enc) are stored alongside the master key:
//   Linux:  ~/.local/share/lark-cli/
//   macOS:  ~/Library/Application Support/lark-cli/
// ---------------------------------------------------------------------------

function getLarkCliKeychainDirs(home: string): string[] {
  const dirs: string[] = []
  switch (process.platform) {
    case 'darwin':
      dirs.push(join(home, 'Library', 'Application Support', 'lark-cli'))
      break
    case 'win32':
      if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'lark-cli'))
      dirs.push(join(home, 'AppData', 'Local', 'lark-cli'))
      break
    default: // linux / freebsd / etc.
      dirs.push(join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'lark-cli'))
  }
  return dirs
}

function readMasterKey(home: string): Buffer | undefined {
  // 1) Try file-based master key (Linux, possibly Windows)
  for (const dir of getLarkCliKeychainDirs(home)) {
    const keyPath = join(dir, 'master.key')
    try {
      const key = readFileSync(keyPath)
      if (key.length === 32) return key
    } catch {}
  }

  // 2) macOS: read from system Keychain via `security` CLI
  if (process.platform === 'darwin') {
    try {
      const raw = execSync(
        'security find-generic-password -s "lark-cli" -w 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 },
      ).trim()
      // Format: "go-keyring-base64:<base64>" or plain base64
      const b64 = raw.startsWith('go-keyring-base64:')
        ? raw.slice('go-keyring-base64:'.length)
        : raw
      const key = Buffer.from(b64, 'base64')
      if (key.length === 32) return key
    } catch {}
  }

  return undefined
}

function decryptAesGcm(key: Buffer, data: Buffer): string | undefined {
  // AES-256-GCM layout: nonce(12) + ciphertext(variable) + tag(16)
  if (data.length < 12 + 16 + 1) return undefined
  const nonce = data.subarray(0, 12)
  const tag = data.subarray(data.length - 16)
  const ciphertext = data.subarray(12, data.length - 16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Attempt to decrypt the app secret from lark-cli's encrypted keychain.
 * Returns the plaintext secret or undefined if decryption isn't possible.
 * This is a best-effort, zero-interaction operation.
 */
export function decryptLarkCliSecret(home: string, appId: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(appId)) return undefined
  const masterKey = readMasterKey(home)
  if (!masterKey) return undefined

  // Find the encrypted secret file — filename pattern: appsecret_<appId>.enc
  const encFilename = `appsecret_${appId}.enc`
  for (const dir of getLarkCliKeychainDirs(home)) {
    const encPath = join(dir, encFilename)
    try {
      const encData = readFileSync(encPath)
      const secret = decryptAesGcm(masterKey, encData)
      if (secret && secret.length > 0) return secret
    } catch {}
  }

  return undefined
}
