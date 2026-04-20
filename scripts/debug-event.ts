#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadDotEnv, resolveStateDir, resolveDomain, importFromLarkCli } from '../src/config.ts'
import { Client, WSClient, EventDispatcher, LoggerLevel } from '@larksuiteoapi/node-sdk'

const HOME = homedir()
const STATE_DIR = resolveStateDir(HOME)
loadDotEnv(join(STATE_DIR, '.env'))

if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  const imported = importFromLarkCli(HOME)
  for (const [k, v] of Object.entries(imported.env)) {
    if (v && process.env[k] === undefined) process.env[k] = v
  }
}

const APP_ID = process.env.FEISHU_APP_ID!
const APP_SECRET = process.env.FEISHU_APP_SECRET!
const DOMAIN = process.env.FEISHU_DOMAIN || resolveDomain(undefined)

const wsClient = new WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: DOMAIN,
  loggerLevel: LoggerLevel.error,
})

console.error('debug: subscribing for 30s — send a DM to the bot…')

const dispatcher = new EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    // Dump the raw event structure
    console.error('=== RAW EVENT (top-level keys) ===')
    console.error(JSON.stringify(Object.keys(data), null, 2))
    console.error('=== event.sender ===')
    console.error(JSON.stringify((data as any).sender, null, 2))
    console.error('=== event.message (partial) ===')
    const msg = (data as any).message
    console.error(JSON.stringify({
      chat_id: msg?.chat_id,
      chat_type: msg?.chat_type,
      message_id: msg?.message_id,
      message_type: msg?.message_type,
      content: msg?.content,
      mentions: msg?.mentions,
    }, null, 2))
  },
})

void wsClient.start({ eventDispatcher: dispatcher })

setTimeout(() => {
  console.error('debug: done')
  wsClient.close()
  process.exit(0)
}, 30_000)
