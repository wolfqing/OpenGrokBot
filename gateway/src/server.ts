import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { runTurn } from './agent.js'
import { listBotsWithLastMessage, listMessages, type BotRow, type Db } from './db.js'
import { createHub, type Hub } from './hub.js'
import type { LLM } from './llm.js'
import type { Pool } from './pool.js'
import { saveScreenshot, screenshotFilePath } from './screenshots.js'

export function createApp(deps: { db: Db; llm: LLM; pool?: Pool; dataDir?: string }): { app: Hono; hub: Hub } {
  const { db, llm, pool } = deps
  const dataDir = deps.dataDir ?? ''
  const hub = createHub()
  const app = new Hono()

  app.get('/api/bots', (c) => c.json(listBotsWithLastMessage(db)))

  app.get('/api/threads/:threadId/messages', (c) => c.json(listMessages(db, c.req.param('threadId'))))

  app.get('/api/screenshots/:botId/:file', async (c) => {
    const path = dataDir ? screenshotFilePath(dataDir, c.req.param('botId'), c.req.param('file')) : null
    if (!path) return c.json({ error: 'not found' }, 404)
    try {
      const body = await readFile(path)
      return c.body(body, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' })
    } catch {
      return c.json({ error: 'not found' }, 404)
    }
  })

  app.post('/api/threads/:threadId/messages', async (c) => {
    const threadId = c.req.param('threadId')
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null
    const text = body?.text?.trim()
    if (!text) return c.json({ error: 'text required' }, 400)
    const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(threadId.replace(/^dm:/, '')) as BotRow | undefined
    if (!bot) return c.json({ error: 'unknown thread' }, 404)
    let soul = ''
    try { soul = bot.soul_path ? readFileSync(bot.soul_path, 'utf8') : '' } catch { /* soul 缺失可运行 */ }
    void runTurn({
      db, llm, bot, soul, threadId,
      ...(pool ? { getComputer: () => pool.get(bot.id) } : {}),
      ...(pool && dataDir ? { saveShot: (botId, shot) => saveScreenshot(dataDir, botId, shot, Date.now()) } : {}),
    }, text, {
      onMessage: (m) => hub.broadcast({ type: 'message', threadId, message: m }),
      onStatus: (botId, state) => hub.broadcast({ type: 'status', botId, state }),
    })
    return c.json({ ok: true }, 202)
  })

  return { app, hub }
}
