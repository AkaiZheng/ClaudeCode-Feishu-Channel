#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  loadDotEnv,
  resolveStateDir,
  resolveDomain,
  importFromLarkCli,
} from '../src/config.ts'
import { FeishuClient } from '../src/feishu.ts'

const HOME = homedir()
const STATE_DIR = resolveStateDir(HOME)
loadDotEnv(join(STATE_DIR, '.env'))

if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  const imported = importFromLarkCli(HOME)
  for (const [k, v] of Object.entries(imported.env)) {
    if (v && process.env[k] === undefined) process.env[k] = v
  }
}

const APP_ID = process.env.FEISHU_APP_ID
const APP_SECRET = process.env.FEISHU_APP_SECRET
const DOMAIN = process.env.FEISHU_DOMAIN || resolveDomain(undefined)

if (!APP_ID || !APP_SECRET) {
  console.error('smoke: FEISHU_APP_ID / FEISHU_APP_SECRET required')
  process.exit(1)
}

const feishu = new FeishuClient({ appId: APP_ID, appSecret: APP_SECRET, domain: DOMAIN })

console.error('smoke: subscribing for 30 s — send the bot a DM from Feishu…')

feishu.subscribe(
  async event => {
    console.error(
      `smoke: received from ${event.sender.open_id} in ${event.message.chat_id}: ${event.message.content}`,
    )
    try {
      const mid = await feishu.sendText(event.message.chat_id, 'smoke ok')
      console.error(`smoke: replied (${mid})`)
    } catch (err) {
      console.error(`smoke: reply failed — ${err}`)
    }
  },
  err => console.error(`smoke: ws error: ${err}`),
)

setTimeout(async () => {
  console.error('smoke: done')
  await feishu.close()
  process.exit(0)
}, 30_000)
