import { describe, test, expect } from 'bun:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decryptLarkCliSecret } from '../src/config.ts'

// Helper: encrypt a plaintext using the same AES-256-GCM scheme lark-cli uses.
function encrypt(key: Buffer, plaintext: string): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag() // 16 bytes
  return Buffer.concat([nonce, ct, tag])
}

describe('decryptLarkCliSecret', () => {
  const fakeHome = join(tmpdir(), `keychain-test-${Date.now()}`)
  const masterKey = randomBytes(32)
  const appId = 'cli_test1234567890'
  const secret = 'MyTestAppSecretValue123456789012'

  // Set up fake keychain directory (Linux-style: ~/.local/share/lark-cli/)
  const keychainDir = join(fakeHome, '.local', 'share', 'lark-cli')

  test('setup', () => {
    mkdirSync(keychainDir, { recursive: true })
    writeFileSync(join(keychainDir, 'master.key'), masterKey)
    writeFileSync(join(keychainDir, `appsecret_${appId}.enc`), encrypt(masterKey, secret))
  })

  test('decrypts secret from file-based keychain', () => {
    const result = decryptLarkCliSecret(fakeHome, appId)
    expect(result).toBe(secret)
  })

  test('returns undefined for unknown appId', () => {
    const result = decryptLarkCliSecret(fakeHome, 'cli_nonexistent')
    expect(result).toBeUndefined()
  })

  test('returns undefined when master key is missing', () => {
    const emptyHome = join(tmpdir(), `keychain-test-empty-${Date.now()}`)
    const result = decryptLarkCliSecret(emptyHome, appId)
    expect(result).toBeUndefined()
  })

  test('returns undefined for corrupted enc file', () => {
    writeFileSync(join(keychainDir, 'appsecret_cli_corrupted.enc'), Buffer.from('garbage'))
    const result = decryptLarkCliSecret(fakeHome, 'cli_corrupted')
    expect(result).toBeUndefined()
  })

  test('returns undefined for wrong master key', () => {
    const wrongKeyHome = join(tmpdir(), `keychain-test-wrongkey-${Date.now()}`)
    const wrongDir = join(wrongKeyHome, '.local', 'share', 'lark-cli')
    mkdirSync(wrongDir, { recursive: true })
    writeFileSync(join(wrongDir, 'master.key'), randomBytes(32)) // different key
    writeFileSync(join(wrongDir, `appsecret_${appId}.enc`), encrypt(masterKey, secret))
    const result = decryptLarkCliSecret(wrongKeyHome, appId)
    expect(result).toBeUndefined()
  })

  test('cleanup', () => {
    rmSync(fakeHome, { recursive: true, force: true })
  })
})
