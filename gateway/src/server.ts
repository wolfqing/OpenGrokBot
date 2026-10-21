import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { runTurn } from './agent.js'
import {
  attachApprovalMessage, createApproval, getApproval, isThumbsUp, latestPendingApproval, resolveApproval,
} from './approvals.js'
import { canMessage, denyReason, type A2ARules } from './a2a.js'
import { authMiddleware, loginHandler } from './auth.js'
import { createBot } from './bots.js'
import {
  ensureDmThread, getMessage, insertMessage, listBotsWithLastMessage, listConversations, listMessages, recordUsage,
  threadMembers, updateMessagePayload, usageSince, type BotRow, type Db, type MessageRow,
} from './db.js'
import { createHub, type GatewayEvent, type Hub } from './hub.js'
import type { LLM } from './llm.js'
import { appendMemoryRule, readMemory } from './memory.js'
import type { Pool } from './pool.js'
import {
  createRoutine, deleteRoutine, describeCron, getRoutine, isValidCron, listRoutines, markRoutineRun, setRoutineEnabled,
  type RoutineRow,
} from './routines.js'
import { screenPagePath } from './screen.js'
import { saveScreenshot, screenshotFilePath } from './screenshots.js'
import type { Scheduler } from './scheduler.js'
import { createTurnQueue } from './turns.js'

export type AppDeps = {
  db: Db
  llm: LLM
  pool?: Pool
  dataDir?: string
  scheduler?: Scheduler
  chiefId?: string
  a2aRules?: A2ARules
  /** 网关令牌。main.ts 总会传；只有单元测试会省略它来跳过鉴权。 */
  token?: string
  allowedOrigins?: string[]
  /** 每个 bot 每天的 token 上限；0 或不传 = 不限 */
  dailyTokens?: number
  vision?: boolean
  timeZone?: string
  now?: () => Date
  /** 一个回合最多调几次模型；不传用 agent 的默认值 */
  maxSteps?: number
  /** 一个回合最长几分钟；0 = 不限，不传用 agent 的默认值 */
  turnMinutes?: number
}

export type GatewayApp = {
  app: Hono
  hub: Hub
  /** 新连上的客户端先收一份「谁在忙」的快照，断线期间错过的状态灯就不会卡住 */
  hello(): GatewayEvent
  runRoutine(routine: RoutineRow, opts?: { force?: boolean }): Promise<'ran' | 'skipped' | 'gone'>
  isBusy(botId: string): boolean
}

type TurnOpts = {
  persistUserMessage?: boolean
  alreadyStored?: boolean
  hop?: number
  group?: { title: string; members: string[] }
  /** 容器冷启动要十几秒：和第一次调模型并行地先把它拉起来 */
  prewarm?: boolean
  /** 排队期间又来的用户消息并进同一个回合 */
  coalesce?: boolean
}

function startOfLocalDay(now: Date): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

const formatCount = (n: number) => n.toLocaleString('en-US')

export function createApp(deps: AppDeps): GatewayApp {
  const { db, llm, pool, scheduler } = deps
  const dataDir = deps.dataDir ?? ''
  const chiefId = deps.chiefId ?? 'chief'
  const a2aRules = deps.a2aRules ?? { chiefId, pairs: [] }
  const now = deps.now ?? (() => new Date())
  const hub = createHub()
  const app = new Hono()
  const turns = createTurnQueue((botId, state) => hub.broadcast({ type: 'status', botId, state }))
  const rounds = createTurnQueue(() => {})
  const routinesInFlight = new Set<number>()
  /** 已落库、还没交给某个回合去回答的用户消息（按线程） */
  const waiting = new Map<string, Set<number>>()

  if (deps.token) {
    app.use('*', authMiddleware(deps.token, deps.allowedOrigins))
    app.get('/auth', loginHandler(deps.token))
  }
  app.get('/api/session', (c) => c.json({ ok: true }))

  const botById = (id: string) => db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined

  /** SOUL.md 是人格，旁边的 AGENTS.md 是操作手册（硬边界写在那里）；缺哪个都能跑。 */
  const loadPersona = (bot: BotRow): { soul: string; manual: string } => {
    if (!bot.soul_path) return { soul: '', manual: '' }
    const read = (path: string) => {
      try { return existsSync(path) ? readFileSync(path, 'utf8') : '' } catch { return '' }
    }
    return { soul: read(bot.soul_path), manual: read(join(dirname(bot.soul_path), 'AGENTS.md')) }
  }

  const budgetNote = (bot: BotRow): string | null => {
    const budget = deps.dailyTokens ?? 0
    if (!budget) return null
    const used = usageSince(db, bot.id, startOfLocalDay(now())).total
    if (used < budget) return null
    return `⚠️ ${bot.name} hit today's token budget (${formatCount(used)} of ${formatCount(budget)} tokens). `
      + 'It picks up again tomorrow — or raise OPENGROKBOT_DAILY_TOKENS.'
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
    // 状态灯由车道统一发，回合自己的开关不再直接广播
    onStatus: () => {},
  })

  function startTurn(bot: BotRow, threadId: string, text: string, opts: TurnOpts = {}): Promise<void> {
    return turns.run(bot.id, threadId, async (signal) => {
      const waitingHere = [...(waiting.get(threadId) ?? [])]
      let order: { pendingIds?: number[]; hiddenIds?: number[] } = { hiddenIds: waitingHere }
      if (opts.alreadyStored) {
        waiting.delete(threadId)
        if (!waitingHere.length) return // 排在前面的那一轮已经把它们答了
        order = { pendingIds: waitingHere }
      }
      if (pool && opts.prewarm) void pool.get(bot.id).catch(() => {})
      const { soul, manual } = loadPersona(bot)
      const memory = dataDir ? await readMemory(dataDir, bot.id) : ''
      const routines = listRoutines(db, bot.id)
        .map((r) => ({ id: r.id, name: r.name, human: describeCron(r.cron), enabled: r.enabled === 1 }))
      await runTurn({
        db, llm, bot, soul, manual, memory, routines, threadId, signal, now,
        hop: opts.hop ?? 0,
        vision: deps.vision === true,
        ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
        ...(deps.maxSteps ? { maxSteps: deps.maxSteps } : {}),
        ...(deps.turnMinutes !== undefined ? { turnTimeoutMs: deps.turnMinutes * 60_000 } : {}),
        ...(opts.group ? { group: opts.group } : {}),
        onUsage: (usage) => recordUsage(db, { botId: bot.id, threadId, usage, at: now().getTime() }),
        checkBudget: () => budgetNote(bot),
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
        onStopRoutine: async (id) => {
          const routine = getRoutine(db, id)
          if (!routine || routine.bot_id !== bot.id) return { ok: false, reason: `You have no routine #${id}.` }
          setRoutineEnabled(db, id, false)
          scheduler?.remove(id)
          return { ok: true, name: routine.name }
        },
      }, text, events(threadId), { persistUserMessage: opts.persistUserMessage, alreadyStored: opts.alreadyStored, ...order })
    }, opts.coalesce ? { coalesceKey: `stored:${threadId}` } : undefined)
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
      { persistUserMessage: false, hop: hop + 1, prewarm: true },
    )
    return { delivered: true, toName: target.name }
  }

  /**
   * 群里一轮：成员各报各的摊子、彼此不用等，所以并行；Chief 要看完所有人的话再发分派表，所以最后。
   * 同一个群的两轮排队进行，不会互相插话。
   */
  function startGroupRound(threadId: string, title: string, text: string): Promise<void> {
    return rounds.run(threadId, threadId, async (signal) => {
      const members = threadMembers(db, threadId)
        .map((id) => botById(id))
        .filter((b): b is BotRow => Boolean(b))
      const group = { title, members: members.map((b) => b.name) }
      const chief = members.find((b) => b.id === chiefId)
      await Promise.all(members.filter((b) => b.id !== chiefId).map((bot) => startTurn(bot, threadId,
        `Your operator asked the group: "${text}". Answer for your own patch only, in two lines or less.`,
        { persistUserMessage: false, group })))
      if (signal.aborted || !chief) return
      await startTurn(chief, threadId,
        `Your operator asked the group: "${text}". Everyone else has reported above. Post the dispatch table now — one "✓ item → @bot · when" line each — then one sentence on what needs your operator today.`,
        { persistUserMessage: false, group })
    })
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
      // 按 id 直接取：chip 可能早就不在最近 200 条里了
      const updated = getMessage(db, approval.message_id)
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
      // 放行的响应不等 bot 干完
      void startTurn(bot, approval.thread_id, seed, { persistUserMessage: false, prewarm: decision === 'approve' })
    }
    return 'ok'
  }

  /** routine 触发和「立即运行」走同一条路：完整的工具与回调，且同一条 routine 不重入。 */
  async function runRoutine(routine: RoutineRow, opts: { force?: boolean } = {}): Promise<'ran' | 'skipped' | 'gone'> {
    const fresh = getRoutine(db, routine.id)
    if (!fresh || (!fresh.enabled && !opts.force)) return 'gone'
    const bot = botById(fresh.bot_id)
    if (!bot) return 'gone'
    if (routinesInFlight.has(fresh.id)) return 'skipped'
    routinesInFlight.add(fresh.id)
    try {
      markRoutineRun(db, fresh.id, now().getTime())
      await startTurn(bot, ensureDmThread(db, bot.id),
        `Your routine "${fresh.name}" just fired. Do this now: ${fresh.instructions}`,
        { persistUserMessage: false, prewarm: true })
      return 'ran'
    } finally {
      routinesInFlight.delete(fresh.id)
    }
  }

  const routineView = (r: RoutineRow) => ({ ...r, human: describeCron(r.cron) })

  app.get('/api/bots', (c) => c.json(listBotsWithLastMessage(db)))

  app.get('/api/conversations', (c) => c.json(listConversations(db)))

  app.get('/api/bots/:botId/computer', async (c) => {
    const botId = c.req.param('botId')
    if (!botById(botId)) return c.json({ error: 'unknown bot' }, 404)
    const routines = listRoutines(db, botId).map(routineView)
    const usage = { today: usageSince(db, botId, startOfLocalDay(now())), budget: deps.dailyTokens ?? 0 }
    if (!pool) return c.json({ botId, running: false, vncUrl: null, routines, usage })
    try {
      const computer = await pool.get(botId)
      const vncUrl = computer.screen ? screenPagePath(botId, computer.screen.password) : null
      return c.json({ botId, running: true, vncUrl, routines, usage })
    } catch (err) {
      // 面板要显示"为什么没屏幕"——白屏是最难查的故障
      return c.json({
        botId, running: false, vncUrl: null, routines, usage,
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

  app.patch('/api/routines/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!getRoutine(db, id)) return c.json({ error: 'unknown routine' }, 404)
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null
    if (typeof body?.enabled !== 'boolean') return c.json({ error: 'enabled must be true or false' }, 400)
    const updated = setRoutineEnabled(db, id, body.enabled)!
    if (body.enabled) scheduler?.add(updated)
    else scheduler?.remove(id)
    return c.json(routineView(updated))
  })

  app.delete('/api/routines/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!deleteRoutine(db, id)) return c.json({ error: 'unknown routine' }, 404)
    scheduler?.remove(id)
    return c.json({ ok: true })
  })

  app.post('/api/routines/:id/run', (c) => {
    const routine = getRoutine(db, Number(c.req.param('id')))
    if (!routine) return c.json({ error: 'unknown routine' }, 404)
    if (routinesInFlight.has(routine.id)) return c.json({ error: 'already running' }, 409)
    void runRoutine(routine, { force: true })
    return c.json({ ok: true }, 202)
  })

  app.get('/api/threads/:threadId/messages', (c) => c.json(listMessages(db, c.req.param('threadId'))))

  app.post('/api/threads/:threadId/stop', (c) => {
    const threadId = c.req.param('threadId')
    // 先停轮次（群里剩下的人不再发言），再停正在跑和排着队的回合；排着队的消息也不再回答
    const stopped = rounds.stopThread(threadId) + turns.stopThread(threadId)
    waiting.delete(threadId)
    return c.json({ stopped })
  })

  app.get('/api/screenshots/:botId/:file', async (c) => {
    const paths = dataDir ? screenshotFilePath(dataDir, c.req.param('botId'), c.req.param('file')) : null
    if (!paths) return c.json({ error: 'not found' }, 404)
    for (const path of paths) {
      try {
        const body = await readFile(path)
        return c.body(body, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable' })
      } catch {
        // 试下一个位置
      }
    }
    return c.json({ error: 'not found' }, 404)
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
      void startGroupRound(threadId, group.title, text)
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

    // 先落库并广播：bot 正忙（比如在跑 routine）时，人也要立刻看到自己发出去的话
    const stored = insertMessage(db, { threadId, sender: 'user', kind: 'text', content: text })
    events(threadId).onMessage(stored)
    waiting.set(threadId, (waiting.get(threadId) ?? new Set()).add(stored.id))
    void startTurn(bot, threadId, text, { alreadyStored: true, prewarm: true, coalesce: true }) // 202 立刻返回，产出走 WS
    return c.json({ ok: true }, 202)
  })

  return {
    app,
    hub,
    hello: () => ({ type: 'hello', statuses: turns.statuses() }),
    runRoutine,
    isBusy: (botId) => turns.isBusy(botId),
  }
}
