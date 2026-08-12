import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { runTurn } from './agent.js'
import { listBotsWithLastMessage, listMessages, type BotRow, type Db } from './db.js'
import { createHub, type Hub } from './hub.js'
import type { LLM } from './llm.js'

export function createApp(deps: { db: Db; llm: LLM }): { app: Hono; hub: Hub } {
  const { db, llm } = deps
  const hub = createHub()
  const app = new Hono()

  app.get('/api/bots', (c) => c.json(listBotsWithLastMessage(db)))

  app.get('/api/threads/:threadId/messages', (c) => c.json(listMessages(db, c.req.param('threadId'))))

  app.post('/api/threads/:threadId/messages', async (c) => {
    const threadId = c.req.param('threadId')
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null
    const text = body?.text?.trim()
    if (!text) return c.json({ error: 'text required' }, 400)
    const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(threadId.replace(/^dm:/, '')) as BotRow | undefined
    if (!bot) return c.json({ error: 'unknown thread' }, 404)
    let soul = ''
    try { soul = bot.soul_path ? readFileSync(bot.soul_path, 'utf8') : '' } catch { /* soul 缺失可运行 */ }
    void runTurn({ db, llm, bot, soul, threadId }, text, {
      onMessage: (m) => hub.broadcast({ type: 'message', threadId, message: m }),
      onStatus: (botId, state) => hub.broadcast({ type: 'status', botId, state }),
    })
    return c.json({ ok: true }, 202)
  })

  return { app, hub }
}
