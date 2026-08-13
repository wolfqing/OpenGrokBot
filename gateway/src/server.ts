import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { runTurn } from './agent.js'
import {
  attachApprovalMessage, createApproval, getApproval, isThumbsUp, latestPendingApproval, resolveApproval,
} from './approvals.js'
import { canMessage, denyReason, type A2ARules } from './a2a.js'
import { createBot } from './bots.js'
import {
  ensureDmThread, insertMessage, listBotsWithLastMessage, listConversations, listMessages, threadMembers,
  updateMessagePayload, type BotRow, type Db, type MessageRow,
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
  chiefId?: string
  a2aRules?: A2ARules
}): { app: Hono; hub: Hub } {
  const { db, llm, pool, scheduler } = deps
  const dataDir = deps.dataDir ?? ''
  const chiefId = deps.chiefId ?? 'chief'
  const a2aRules = deps.a2aRules ?? { chiefId, pairs: [] }
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
    opts: { persistUserMessage?: boolean; hop?: number; group?: { title: string; members: string[] } } = {},
  ): Promise<void> {
    const memory = dataDir ? await readMemory(dataDir, bot.id) : ''
    await runTurn({
      db, llm, bot, soul: readSoul(bot), threadId, memory,
      hop: opts.hop ?? 0,
      ...(opts.group ? { group: opts.group } : {}),
      onMessageBot: ({ to, content }) => relay(bot, to, content, opts.hop ?? 0),
      // 提前把容器拉起来，用户点开面板时屏幕已经在了
      ...(pool ? { onAskForLogin: async () => { await pool.get(bot.id) } } : {}),
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
    }, text, events(threadId), { persistUserMessage: opts.persistUserMessage })
  }

  /** a2a：把任务放进目标 bot 的单聊，并让它接着干。 */
  async function relay(
    from: BotRow,
    to: string,
    content: string,
    hop: number,
  ): Promise<{ delivered: boolean; reason?: string; toName?: string }> {
    if (!canMessage(a2aRules, from.id, to)) {
      return { delivered: false, reason: denyReason(a2aRules, from.id, to) }
    }
    const target = botById(to)
    if (!target) return { delivered: false, reason: `There is no teammate called ${to}.` }

    const targetThread = ensureDmThread(db, target.id)
    const chip = insertMessage(db, {
      threadId: targetThread, sender: from.id, kind: 'bot_ref',
      payload: { from: from.id, fromName: from.name, content },
    })
    hub.broadcast({ type: 'message', threadId: targetThread, message: chip })

    // 不 await：交接方不该被接收方的整轮工作卡住
    void startTurn(
      target,
      targetThread,
      `@${from.name} (${from.id}) handed you this: ${content}\nPick it up now and report back in this thread.`,
      { persistUserMessage: false, hop: hop + 1 },
    )
    return { delivered: true, toName: target.name }
  }

  /** 群里一轮：成员依次发言，Chief 收口——所以每个人都看得见前面的话。 */
  async function runGroupRound(threadId: string, title: string, text: string): Promise<void> {
    const members = threadMembers(db, threadId)
      .map((id) => botById(id))
      .filter((b): b is BotRow => Boolean(b))
    const names = members.map((b) => b.name)
    const speakers = [...members.filter((b) => b.id !== chiefId), ...members.filter((b) => b.id === chiefId)]
    for (const bot of speakers) {
      const seed = bot.id === chiefId
        ? `Your operator asked the group: "${text}". Everyone else has reported above. Post the dispatch table now — one "✓ item → @bot · when" line each — then one sentence on what needs your operator today.`
        : `Your operator asked the group: "${text}". Answer for your own patch only, in two lines or less.`
      await startTurn(bot, threadId, seed, { persistUserMessage: false, group: { title, members: names } })
    }
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
      void startTurn(bot, approval.thread_id, seed, { persistUserMessage: false }) // 放行的响应不等 bot 干完
    }
    return 'ok'
  }

  app.get('/api/bots', (c) => c.json(listBotsWithLastMessage(db)))

  app.get('/api/conversations', (c) => c.json(listConversations(db)))

  app.get('/api/bots/:botId/computer', async (c) => {
    const botId = c.req.param('botId')
    if (!botById(botId)) return c.json({ error: 'unknown bot' }, 404)
    const routines = listRoutines(db, botId).map((r) => ({ ...r, human: describeCron(r.cron) }))
    if (!pool) return c.json({ botId, running: false, vncUrl: null, routines })
    try {
      const computer = await pool.get(botId)
      return c.json({ botId, running: true, vncUrl: computer.vncUrl ?? null, routines })
    } catch (err) {
      // 面板要显示"为什么没屏幕"——白屏是最难查的故障
      return c.json({
        botId, running: false, vncUrl: null, routines,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  app.post('/api/bots', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: string; role?: string } | null
    const group = db.prepare(`SELECT id FROM threads WHERE kind = 'group' ORDER BY id LIMIT 1`)
      .get() as { id: string } | undefined
    try {
      const bot = await createBot(db, {
        dataDir,
        name: String(body?.name ?? ''),
        role: String(body?.role ?? ''),
        groupId: group?.id,
      })
      return c.json(bot, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

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

    if (threadId.startsWith('group:')) {
      const group = db.prepare(`SELECT title FROM threads WHERE id = ? AND kind = 'group'`)
        .get(threadId) as { title: string } | undefined
      if (!group) return c.json({ error: 'unknown thread' }, 404)
      events(threadId).onMessage(insertMessage(db, { threadId, sender: 'user', kind: 'text', content: text }))
      void runGroupRound(threadId, group.title, text)
      return c.json({ ok: true }, 202)
    }

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

    void startTurn(bot, threadId, text) // 202 立刻返回，产出走 WS
    return c.json({ ok: true }, 202)
  })

  return { app, hub }
}
