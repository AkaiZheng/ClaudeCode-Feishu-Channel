#!/usr/bin/env bun
/**
 * Interactive setup script for Feishu Channel.
 * Designed to be run by Claude Code — outputs structured status and URLs
 * that CC can present to the user.
 *
 * Usage: bun scripts/setup.ts
 */
import { execSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { decryptLarkCliSecret } from '../src/config.ts'
import { writeMcpConfig } from '../src/mcp-config.ts'

const HOME = homedir()
const STATE_DIR = join(HOME, '.claude', 'channels', 'feishu')
const ENV_FILE = join(STATE_DIR, '.env')
const PROJECT_DIR = join(import.meta.dir, '..')

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim()
  } catch {
    return ''
  }
}

function check(label: string, ok: boolean, detail?: string) {
  const icon = ok ? '✅' : '❌'
  console.log(`${icon} ${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}

// ─── Checks ───────────────────────────────────────────────────

console.log('\n🔍 Checking environment...\n')

const hasBun = check('Bun', run('bun --version').length > 0, run('bun --version'))
const hasLarkCli = check('lark-cli', run('lark-cli --version').length > 0, run('lark-cli --version'))
const hasNodeModules = check('node_modules', existsSync(join(PROJECT_DIR, 'node_modules')))

if (!hasBun) {
  console.log('\n⚠️  Bun is required. Install: curl -fsSL https://bun.sh/install | bash')
  process.exit(1)
}

if (!hasLarkCli) {
  console.log('\n⚠️  lark-cli is required. Install: npm install -g @larksuite/cli')
  process.exit(1)
}

if (!hasNodeModules) {
  console.log('\n📦 Installing dependencies...')
  execSync('bun install', { cwd: PROJECT_DIR, stdio: 'inherit' })
}

// ─── Link skills into ~/.claude/skills/ ───────────────────────
// Claude Code only scans ~/.claude/skills/, so /feishu:access and
// /feishu:configure won't resolve unless we surface them there.

const SKILLS_DIR = join(HOME, '.claude', 'skills')
mkdirSync(SKILLS_DIR, { recursive: true })

function linkSkill(source: string, name: string) {
  const dest = join(SKILLS_DIR, name)
  try {
    lstatSync(dest)
    unlinkSync(dest)
  } catch {}
  symlinkSync(source, dest, 'dir')
}

linkSkill(join(PROJECT_DIR, 'skills', 'access'), 'feishu-access')
linkSkill(join(PROJECT_DIR, 'skills', 'configure'), 'feishu-configure')
console.log(`🔗 Skills linked to ${SKILLS_DIR}/`)

// ─── Rewrite .mcp.json with absolute paths ───────────────────
// Claude Code spawns the MCP subprocess without the user's shell PATH,
// so `bun` may not resolve. Also, no cwd means wrong working directory.

function findBun(): string {
  // 1) Current process (running under bun)
  if (process.execPath && basename(process.execPath).startsWith('bun')) return process.execPath
  // 2) which bun
  const fromPath = run('which bun')
  if (fromPath) return fromPath
  // 3) Common install locations
  const candidates = [
    join(HOME, '.bun', 'bin', 'bun'),
    '/usr/local/bin/bun',
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return 'bun' // fallback to bare name
}

const bunPath = findBun()
writeMcpConfig({ bunPath, projectDir: PROJECT_DIR })
console.log(`🔧 .mcp.json updated with absolute paths (bun: ${bunPath})`)

// ─── App Config ───────────────────────────────────────────────

console.log('\n🔍 Checking lark-cli app configuration...\n')

const configOutput = run('lark-cli config show')
const appIdMatch = configOutput.match(/cli_[a-z0-9]+/)
const hasApp = !!appIdMatch

if (hasApp) {
  check('App configured', true, appIdMatch![0])
} else {
  check('App configured', false)
  console.log('\n🚀 Creating a new Feishu app...')
  console.log('   Running: lark-cli config init --new')
  console.log('   ⏳ Waiting for user to complete browser setup...\n')
  console.log('   ACTION_REQUIRED: A URL will appear below. Open it to create your Feishu app.\n')

  try {
    execSync('lark-cli config init --new', { stdio: 'inherit', timeout: 300000 })
  } catch {
    console.log('\n❌ App creation failed or timed out. Please retry.')
    process.exit(1)
  }
}

// Re-read config after potential creation
const finalConfig = run('lark-cli config show')
const finalAppId = finalConfig.match(/cli_[a-z0-9]+/)?.[0]

if (!finalAppId) {
  console.log('\n❌ Could not detect app ID. Run `lark-cli config show` to debug.')
  process.exit(1)
}

// ─── Auth Check ───────────────────────────────────────────────

console.log('\n🔍 Checking user authentication...\n')

const authStatus = run('lark-cli auth status')
const isLoggedIn = authStatus.includes('userName') || authStatus.includes('logged in')

if (isLoggedIn) {
  check('User authenticated', true)
} else {
  check('User authenticated', false)
  console.log('\n🔐 Initiating login...')
  console.log('   ACTION_REQUIRED: A URL will appear below. Open it to authorize.\n')

  try {
    execSync('lark-cli auth login --domain im', {
      stdio: 'inherit',
      timeout: 300000,
    })
  } catch {
    console.log('\n❌ Login failed or timed out. Please retry.')
    process.exit(1)
  }
}

// ─── .env Setup ───────────────────────────────────────────────

console.log('\n🔍 Checking channel credentials...\n')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

let envContent = ''
try { envContent = readFileSync(ENV_FILE, 'utf8') } catch {}

const hasEnvAppId = envContent.includes('FEISHU_APP_ID=')
const hasEnvSecret = envContent.includes('FEISHU_APP_SECRET=') && !envContent.includes('FEISHU_APP_SECRET=\n')

if (hasEnvAppId && hasEnvSecret) {
  check('.env configured', true, ENV_FILE)
} else {
  console.log(`   Writing ${ENV_FILE}...`)

  // Try to extract secret from lark-cli config
  const secretMatch = finalConfig.match(/appSecret:\s*(\S+)/)
  let secret = secretMatch?.[1] || ''

  // lark-cli might show masked or keychain reference
  if (!secret || secret === '***' || secret.includes('keychain')) {
    // Try to decrypt from lark-cli's encrypted keychain
    if (finalAppId) {
      const decrypted = decryptLarkCliSecret(HOME, finalAppId)
      if (decrypted) {
        secret = decrypted
        console.log('🔓 Decrypted App Secret from lark-cli keychain.')
      }
    }
  }

  if (!secret || secret === '***' || secret.includes('keychain')) {
    console.log('\n⚠️  App Secret not available from lark-cli (stored in OS keychain).')
    console.log('   ACTION_REQUIRED: Please provide your App Secret.')
    console.log(`   Find it at: https://open.feishu.cn/app/${finalAppId}/baseinfo`)
    console.log('')
    console.log('   Then run:')
    console.log(`   echo "FEISHU_APP_SECRET=<your-secret>" >> ${ENV_FILE}`)
    console.log('')

    // Write what we can
    if (!hasEnvAppId) {
      writeFileSync(ENV_FILE, `FEISHU_APP_ID=${finalAppId}\nFEISHU_APP_SECRET=\n`, { mode: 0o600 })
    }
  } else {
    writeFileSync(ENV_FILE, `FEISHU_APP_ID=${finalAppId}\nFEISHU_APP_SECRET=${secret}\n`, { mode: 0o600 })
    check('.env written', true)
  }
}

// ─── Smoke Test ───────────────────────────────────────────────

console.log('\n🔍 Testing WebSocket event subscription...\n')

try {
  const result = execSync('timeout 8 bun scripts/smoke.ts 2>&1 || true', {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    timeout: 15000,
  })

  if (result.includes('event-dispatch is ready')) {
    check('WebSocket subscription', true, 'connected')
  } else {
    check('WebSocket subscription', false)
    console.log('\n⚠️  Could not connect to Feishu event stream.')
    console.log('   ACTION_REQUIRED: Configure event subscription in Feishu developer console:')
    console.log(`   1. Open https://open.feishu.cn/app/${finalAppId}/event`)
    console.log('   2. Enable 「使用长连接接收事件」')
    console.log('   3. Add event: im.message.receive_v1')
    console.log('   4. Publish a version if not already done (创建版本 → 审批)')
  }
} catch {
  check('WebSocket subscription', false, 'test timed out')
}

// ─── Summary ──────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60))
console.log('\n🎉 Setup complete! To start the channel:\n')
console.log(`   cd ${PROJECT_DIR}`)
console.log('   claude --dangerously-load-development-channels server:feishu')
console.log('\n   Then send a DM to your bot in Feishu — it will appear in Claude Code.')
console.log('')
