import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { runTurn } from './agent.js'
import {
  attachApprovalMessage, createApproval, getApproval, isThumbsUp, latestPendingApproval, resolveApproval,
} from './approvals.js'
import {
  insertMessage, listBotsWithLastMessage, listMessages, updateMessagePayload,
  type BotRow, type Db, type MessageRow,
} from './db.js'
import { createHub, type Hub } from './hub.js'
import type { LLM } from './llm.js'
import { appendMemoryRule, readMemory } from './memory.js'
import type { Pool } from './pool.js'
import { createRoutine, describeCron, isValidCron, listRoutines } from './routines.js'
import { saveScreenshot, screenshotFilePath } from './screenshots.js'
import type { Scheduler } from './scheduler.js'

export function createApp(deps: {
  db: Db
  llm: LLM
  pool?: Pool
  dataDir?: string
  scheduler?: Scheduler
}): { app: Hono; hub: Hub } {
  const { db, llm, pool, scheduler } = deps
  const dataDir = deps.dataDir ?? ''
  const hub = createHub()
  const app = new Hono()

  const botById = (id: string) => db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined

  const readSoul = (bot: BotRow): string => {
    try { return bot.soul_path ? readFileSync(bot.soul_path, 'utf8') : '' } catch { return '' /* soul 缺失可运行 */ }
  }

  const events = (threadId: string) => ({
    onMessage: (m: MessageRow) => {
      // chip 落库后才知道它的 message id，回填给审批行，放行时才能把这张 chip 翻成已决
      if (m.kind === 'approval_request') {
        const approvalId = (m.payload as { approvalId?: number } | null)?.approvalId
        if (approvalId) attachApprovalMessage(db, approvalId, m.id)
      }
      hub.broadcast({ type: 'message', threadId, message: m })
    },
    onStatus: (botId: string, state: 'thinking' | 'idle') => hub.broadcast({ type: 'status', botId, state }),
  })

  async function startTurn(
    bot: BotRow,
    threadId: string,
    text: string,
    opts: { persistUserMessage?: boolean } = {},
  ): Promise<void> {
    const memory = dataDir ? await readMemory(dataDir, bot.id) : ''
    void runTurn({
      db, llm, bot, soul: readSoul(bot), threadId, memory,
      ...(pool ? { getComputer: () => pool.get(bot.id) } : {}),
      ...(pool && dataDir ? { saveShot: (botId, shot) => saveScreenshot(dataDir, botId, shot, Date.now()) } : {}),
      onApproval: async ({ action, detail }) => {
        const approval = createApproval(db, { threadId, botId: bot.id, action, detail })
        return { approvalId: approval.id }
      },
      ...(dataDir ? { onSaveMemory: (rule: string) => appendMemoryRule(dataDir, bot.id, rule) } : {}),
      onCreateRoutine: async ({ name, cron, instructions }) => {
        if (!isValidCron(cron)) throw new Error(`not a valid cron expression: ${cron}`)
        const routine = createRoutine(db, { botId: bot.id, name, cron, instructions })
        scheduler?.add(routine)
        return { id: routine.id, name: routine.name, cron: routine.cron, human: describeCron(routine.cron) }
      },
    }, text, events(threadId), opts)
  }

  /** 放行/驳回：翻转 chip、留一条决定记录、再用不可见 seed 让 bot 续跑。 */
  async function settleApproval(id: number, decision: 'approve' | 'discard'): Promise<'ok' | 'gone' | 'settled'> {
    if (!getApproval(db, id)) return 'gone'
    const approval = resolveApproval(db, id, decision)
    if (!approval) return 'settled'

    if (approval.message_id) {
      updateMessagePayload(db, approval.message_id, {
        approvalId: approval.id, action: approval.action, detail: approval.detail, status: approval.status,
      })
      const updated = listMessages(db, approval.thread_id).find((m) => m.id === approval.message_id)
      if (updated) hub.broadcast({ type: 'message', threadId: approval.thread_id, message: updated })
    }

    const resolved = insertMessage(db, {
      threadId: approval.thread_id, sender: 'user', kind: 'approval_resolved',
      payload: { approvalId: approval.id, action: approval.action, decision },
    })
    hub.broadcast({ type: 'message', threadId: approval.thread_id, message: resolved })

    const bot = botById(approval.bot_id)
    if (bot) {
      const seed = decision === 'approve'
        ? `Your operator approved: ${approval.action}. Carry it out now and report what actually happened.`
        : `Your operator discarded: ${approval.action}. Do not do it. Acknowledge in one line and move on.`
      await startTurn(bot, approval.thread_id, seed, { persistUserMessage: false })
    }
    return 'ok'
  }

  app.get('/api/bots', (c) => c.json(listBotsWithLastMessage(db)))

  app.get('/api/bots/:botId/routines', (c) => c.json(listRoutines(db, c.req.param('botId'))))

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

  app.post('/api/approvals/:id', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { decision?: string } | null
    if (body?.decision !== 'approve' && body?.decision !== 'discard') {
      return c.json({ error: 'decision must be "approve" or "discard"' }, 400)
    }
    const outcome = await settleApproval(Number(c.req.param('id')), body.decision)
    if (outcome === 'gone') return c.json({ error: 'unknown approval' }, 404)
    if (outcome === 'settled') return c.json({ error: 'already decided' }, 409)
    return c.json({ ok: true }, 202)
  })

  app.post('/api/threads/:threadId/messages', async (c) => {
    const threadId = c.req.param('threadId')
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null
    const text = body?.text?.trim()
    if (!text) return c.json({ error: 'text required' }, 400)
    const bot = botById(threadId.replace(/^dm:/, ''))
    if (!bot) return c.json({ error: 'unknown thread' }, 404)

    // 一个光秃秃的 👍 就是放行，不该变成一条闲聊
    if (isThumbsUp(text)) {
      const pending = latestPendingApproval(db, threadId)
      if (pending) {
        await settleApproval(pending.id, 'approve')
        return c.json({ ok: true, approved: true }, 202)
      }
    }

    await startTurn(bot, threadId, text)
    return c.json({ ok: true }, 202)
  })

  return { app, hub }
}
