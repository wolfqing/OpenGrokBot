import { MAX_HOPS } from './a2a.js'
import type { BotComputer, Shot } from './computer.js'
import { insertMessage, listMessages, updateMessagePayload, type BotRow, type Db, type MessageRow } from './db.js'
import type { ChatMsg, LLM, ToolCall, Usage } from './llm.js'
import { buildSystemPrompt, timeNote, withTimeNote, type PromptRoutine } from './prompts.js'
import { validateReportPayload } from './report.js'
import { buildTools } from './tools.js'

export type AgentEvents = {
  onMessage: (m: MessageRow) => void
  onStatus: (botId: string, state: 'thinking' | 'idle') => void
}

export type AgentDeps = {
  db: Db
  llm: LLM
  bot: BotRow
  soul: string
  threadId: string
  getComputer?: () => Promise<BotComputer>
  saveShot?: (botId: string, shot: Shot) => Promise<{ url: string; width: number; height: number }>
  memory?: string
  /** AGENTS.md：操作手册（硬边界在这里） */
  manual?: string
  routines?: PromptRoutine[]
  onApproval?: (input: { action: string; detail: string }) => Promise<{ approvalId: number }>
  onSaveMemory?: (rule: string) => Promise<{ rule: string; diff: string; total: number }>
  onCreateRoutine?: (input: { name: string; cron: string; instructions: string }) =>
    Promise<{ id: number; name: string; cron: string; human: string }>
  onStopRoutine?: (id: number) => Promise<{ ok: boolean; name?: string; reason?: string }>
  hop?: number
  group?: { title: string; members: string[] }
  onMessageBot?: (input: { to: string; content: string }) =>
    Promise<{ delivered: boolean; reason?: string; toName?: string }>
  onAskForLogin?: (input: { site: string; why: string }) => Promise<void>
  /** 操作者按「停止」时触发 */
  signal?: AbortSignal
  onUsage?: (usage: Usage) => void
  /** 每次调模型前问一句；返回一句话 = 今天的额度用完了，回合就此打住 */
  checkBudget?: () => string | null
  /** 把截图喂回模型（需要支持图片输入的模型） */
  vision?: boolean
  now?: () => Date
  timeZone?: string
}

const MAX_STEPS = 12
const HISTORY_LIMIT = 40
const MAX_TOOL_CHARS = 4000
const MAX_SLICE_CHARS = 12000
const MAX_ACTIVITY_STEPS = 40

type ToolOutcome = { text: string; image?: string }

export async function runTurn(
  deps: AgentDeps,
  userText: string,
  events: AgentEvents,
  /**
   * persistUserMessage=false：不可见 seed（routine、放行、群发言、转交），只给模型看。
   * alreadyStored=true：用户消息早已落库并广播（排队期间就该让人看见），历史里自然带着它。
   */
  opts: { persistUserMessage?: boolean; alreadyStored?: boolean } = {},
): Promise<void> {
  const { db, llm, bot, soul, threadId, signal } = deps
  const hasComputer = Boolean(deps.getComputer)
  const alreadyStored = opts.alreadyStored === true
  const persistUserMessage = opts.persistUserMessage !== false && !alreadyStored
  const say = (content: string) => events.onMessage(insertMessage(db, { threadId, sender: bot.id, kind: 'text', content }))
  if (persistUserMessage) {
    events.onMessage(insertMessage(db, { threadId, sender: 'user', kind: 'text', content: userText }))
  }
  events.onStatus(bot.id, 'thinking')
  const activity = createActivity(deps, events)
  try {
    const canRelay = Boolean(deps.onMessageBot)
    const history: ChatMsg[] = [
      {
        role: 'system',
        content: buildSystemPrompt(bot, soul, {
          hasComputer, memory: deps.memory, group: deps.group, canRelay, manual: deps.manual, routines: deps.routines,
        }),
      },
      ...listMessages(db, threadId, HISTORY_LIMIT).map((m) => toChatMsg(m, bot.id)),
    ]
    // routine 触发 / 审批放行 / 群发言不落库，但模型必须看到这句话才知道要干什么
    if (!persistUserMessage && !alreadyStored) history.push({ role: 'user', content: userText })
    const now = (deps.now ?? (() => new Date()))()
    const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const messages = withTimeNote(history, timeNote(now, timeZone))
    const tools = buildTools({ hasComputer, canRelay })
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) return stopped(say)
      const overBudget = deps.checkBudget?.()
      if (overBudget) {
        say(overBudget)
        return
      }
      const turn = await llm.chat(messages, tools, { signal })
      if (turn.usage) deps.onUsage?.(turn.usage)
      if (turn.toolCalls.length > 0) {
        messages.push(turn.raw)
        let latestImage: string | undefined
        for (const call of turn.toolCalls) {
          if (signal?.aborted) return stopped(say)
          const outcome = await execToolCall(deps, call, events, activity)
          messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.text })
          latestImage = outcome.image ?? latestImage
        }
        if (deps.vision && latestImage) showLatestImage(messages, latestImage)
        continue
      }
      const text = turn.content?.trim()
      if (text) say(text)
      return
    }
    say(`⚠️ ${bot.name} stopped after ${MAX_STEPS} steps without a final reply.`)
  } catch (err) {
    if (signal?.aborted) return stopped(say)
    say(`⚠️ ${bot.name} hit an error: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    activity.close()
    events.onStatus(bot.id, 'idle')
  }
}

function stopped(say: (content: string) => void): void {
  say('⏹ Stopped. Tell me when to pick it back up.')
}

/** 模型只看最新一张截图：旧图换成一句占位，免得每一步都重复付图片的 token。 */
function showLatestImage(messages: ChatMsg[], dataUrl: string): void {
  for (const m of messages) {
    if (m.images?.length) {
      delete m.images
      m.content = '[an earlier screenshot, no longer shown]'
    }
  }
  messages.push({
    role: 'user',
    content: 'This is the screenshot you just took. Your operator sees it in the thread; describe only what is really on it.',
    images: [dataUrl],
  })
}

type ActivityStep = { tool: string; summary: string; ok?: boolean; ms?: number }
type Activity = {
  start(tool: string, summary: string): ActivityStep
  finish(step: ActivityStep, ok: boolean, ms: number): void
  close(): void
}

/** 一个回合一张「在干什么」的卡片：第一次动电脑时落库，之后同一个 id 就地更新并广播。 */
function createActivity(deps: AgentDeps, events: AgentEvents): Activity {
  let row: MessageRow | null = null
  const steps: ActivityStep[] = []
  let done = false
  const publish = () => {
    const payload = JSON.parse(JSON.stringify({ steps, done })) as { steps: ActivityStep[]; done: boolean }
    if (!row) {
      row = insertMessage(deps.db, { threadId: deps.threadId, sender: deps.bot.id, kind: 'activity', payload })
    } else {
      updateMessagePayload(deps.db, row.id, payload)
      row = { ...row, payload }
    }
    events.onMessage(row)
  }
  return {
    start(tool, summary) {
      const step: ActivityStep = { tool, summary }
      if (steps.length < MAX_ACTIVITY_STEPS) steps.push(step)
      publish()
      return step
    },
    finish(step, ok, ms) {
      step.ok = ok
      step.ms = ms
      publish()
    },
    close() {
      if (!row) return
      done = true
      publish()
    },
  }
}

const COMPUTER_TOOL_NAMES = new Set([
  'shell', 'read_file', 'write_file', 'browser_goto', 'browser_extract', 'browser_click', 'browser_type',
  'browser_press', 'browser_scroll', 'browser_back', 'browser_screenshot', 'ask_for_login',
])

/** 请人接管不是「电脑上的一步」，它有自己的卡片 */
const ACTIVITY_TOOL_NAMES = new Set([...COMPUTER_TOOL_NAMES].filter((name) => name !== 'ask_for_login'))

const WORKFLOW_TOOL_NAMES = new Set(['hold_for_approval', 'save_memory', 'create_routine', 'stop_routine', 'message_bot'])

async function execToolCall(deps: AgentDeps, call: ToolCall, events: AgentEvents, activity: Activity): Promise<ToolOutcome> {
  const args = (call.args ?? {}) as Record<string, unknown>
  if (call.name === 'message_user') return { text: execMessageUser(deps, args, events) }
  if (WORKFLOW_TOOL_NAMES.has(call.name)) {
    try {
      return { text: truncate(await execWorkflowTool(deps, call.name, args, events)) }
    } catch (err) {
      return { text: `Tool ${call.name} failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  if (!COMPUTER_TOOL_NAMES.has(call.name)) return { text: `Unknown tool: ${call.name}` }
  if (!deps.getComputer) return { text: 'You have no computer attached right now — this tool is unavailable.' }
  const step = ACTIVITY_TOOL_NAMES.has(call.name) ? activity.start(call.name, summarize(call.name, args)) : null
  const started = Date.now()
  try {
    const outcome = await execComputerTool(deps, call.name, args, events)
    if (step) activity.finish(step, true, Date.now() - started)
    return outcome
  } catch (err) {
    if (step) activity.finish(step, false, Date.now() - started)
    // 工具失败必须回喂模型（让它换招/如实汇报），而不是炸掉整个回合
    return { text: `Tool ${call.name} failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function summarize(tool: string, args: Record<string, unknown>): string {
  const pick = (key: string) => String(args[key] ?? '').trim().split('\n')[0]!.slice(0, 120)
  switch (tool) {
    case 'shell': return pick('cmd')
    case 'read_file':
    case 'write_file': return pick('path')
    case 'browser_goto': return pick('url')
    case 'browser_extract': return typeof args.offset === 'number' && args.offset > 0 ? `page text from ${args.offset}` : 'page text'
    case 'browser_click':
    case 'browser_type': return pick('target')
    case 'browser_press': return pick('key')
    case 'browser_scroll': return pick('direction') || 'down'
    case 'browser_back': return 'previous page'
    case 'browser_screenshot': return pick('caption') || 'screen'
    default: return ''
  }
}

function execMessageUser(deps: AgentDeps, args: Record<string, unknown>, events: AgentEvents): string {
  if (args.kind !== 'report') return 'Unsupported kind; only "report" exists today.'
  const payload = validateReportPayload(args.payload)
  if (!payload) return 'Invalid report payload: need lines[] of {system, result, count?} plus optional closing.'
  events.onMessage(insertMessage(deps.db, { threadId: deps.threadId, sender: deps.bot.id, kind: 'report', payload }))
  return 'Report delivered.'
}

async function execWorkflowTool(
  deps: AgentDeps,
  name: string,
  args: Record<string, unknown>,
  events: AgentEvents,
): Promise<string> {
  switch (name) {
    case 'hold_for_approval': {
      if (!deps.onApproval) return 'Approvals are not available on this gateway.'
      const action = String(args.action ?? '').trim()
      if (!action) return 'hold_for_approval needs a one-line "action".'
      const detail = String(args.detail ?? '').trim()
      const { approvalId } = await deps.onApproval({ action, detail })
      events.onMessage(insertMessage(deps.db, {
        threadId: deps.threadId, sender: deps.bot.id, kind: 'approval_request',
        payload: { approvalId, action, detail, status: 'pending' },
      }))
      return "Held for your operator's approval. Stop here — do not perform it."
    }
    case 'save_memory': {
      if (!deps.onSaveMemory) return 'Memory is not available on this gateway.'
      const rule = String(args.rule ?? '').trim()
      if (!rule) return 'save_memory needs a "rule".'
      const saved = await deps.onSaveMemory(rule)
      if (!saved.diff) return 'That rule was already on file.'
      events.onMessage(insertMessage(deps.db, {
        threadId: deps.threadId, sender: deps.bot.id, kind: 'memory_updated',
        payload: { rule: saved.rule, diff: saved.diff, total: saved.total },
      }))
      return 'Rule saved to MEMORY.md.'
    }
    case 'create_routine': {
      if (!deps.onCreateRoutine) return 'Routines are not available on this gateway.'
      const routineName = String(args.name ?? '').trim()
      const cron = String(args.cron ?? '').trim()
      const instructions = String(args.instructions ?? '').trim()
      if (!routineName || !cron || !instructions) return 'create_routine needs "name", "cron" and "instructions".'
      const routine = await deps.onCreateRoutine({ name: routineName, cron, instructions })
      events.onMessage(insertMessage(deps.db, {
        threadId: deps.threadId, sender: deps.bot.id, kind: 'routine_created',
        payload: { routineId: routine.id, name: routine.name, cron: routine.cron, human: routine.human },
      }))
      return `Routine "${routine.name}" scheduled (${routine.human}).`
    }
    case 'stop_routine': {
      if (!deps.onStopRoutine) return 'Routines are not available on this gateway.'
      const id = Number(args.id)
      if (!Number.isInteger(id) || id <= 0) return 'stop_routine needs the numeric id of one of your routines.'
      const result = await deps.onStopRoutine(id)
      if (!result.ok) return result.reason ?? `Could not stop routine #${id}.`
      return `Stopped routine #${id}${result.name ? ` "${result.name}"` : ''}. It will not fire again.`
    }
    case 'message_bot': {
      if (!deps.onMessageBot) return 'Relaying to teammates is not available on this gateway.'
      // 两跳足够「分派 → 执行方回话」；再深就是两个 bot 在互相回声
      if ((deps.hop ?? 0) >= MAX_HOPS) {
        return 'Relay limit reached — reply to your operator instead of passing this on again.'
      }
      const to = String(args.to ?? '').trim()
      const content = String(args.content ?? '').trim()
      if (!to || !content) return 'message_bot needs "to" and "content".'
      const result = await deps.onMessageBot({ to, content })
      if (!result.delivered) return result.reason ?? `Could not reach ${to}.`
      return `Handed to ${result.toName ?? to}.`
    }
    default:
      return `Unknown tool: ${name}`
  }
}

function numberArg(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : fallback
}

/** 长网页/长文件分片给：每片告诉模型下一片从哪开始，而不是悄悄截断在 4000 字。 */
function sliceForModel(text: string, args: Record<string, unknown>, tool: string, noun: string): string {
  const total = text.length
  const start = Math.min(numberArg(args.offset, 0, total), total)
  const size = Math.max(numberArg(args.maxChars, MAX_TOOL_CHARS, MAX_SLICE_CHARS), 1)
  const end = Math.min(start + size, total)
  let out = text.slice(start, end)
  if (end < total) out += `\n…(showing characters ${start}–${end} of ${total}; call ${tool} with offset=${end} for more)`
  else if (start > 0) out += `\n(end of ${noun})`
  return out
}

/** 命令输出两头都留：开头是上下文，报错通常在结尾。 */
function headAndTail(text: string, max = MAX_TOOL_CHARS): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const omitted = text.length - half * 2
  return `${text.slice(0, half)}\n…(${omitted} characters omitted — pipe through head, tail or sed -n to see a part)…\n${text.slice(-half)}`
}

async function linksSection(computer: BotComputer): Promise<string> {
  const links = await computer.links().catch(() => [])
  const lines: string[] = []
  let size = 0
  for (const link of links.slice(0, 40)) {
    const line = `- ${link.text || '(no text)'} → ${link.href}`
    if (size + line.length > 2500) break
    lines.push(line)
    size += line.length + 1
  }
  return lines.length ? `\n\nLinks on this page:\n${lines.join('\n')}` : ''
}

async function execComputerTool(
  deps: AgentDeps,
  name: string,
  args: Record<string, unknown>,
  events: AgentEvents,
): Promise<ToolOutcome> {
  const computer = await deps.getComputer!()
  switch (name) {
    case 'shell': {
      const r = await computer.shell(String(args.cmd ?? ''), typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined)
      const text = [`exit ${r.exitCode}`, r.stdout.trim(), r.stderr.trim() ? `stderr:\n${r.stderr.trim()}` : '']
        .filter(Boolean).join('\n')
      return { text: headAndTail(text) }
    }
    case 'read_file':
      return { text: sliceForModel(await computer.readFile(String(args.path ?? '')), args, 'read_file', 'file') }
    case 'write_file':
      await computer.writeFile(String(args.path ?? ''), String(args.content ?? ''))
      return { text: `Wrote ${String(args.path ?? '')}.` }
    case 'browser_goto': {
      const r = await computer.goto(String(args.url ?? ''))
      return { text: `Now on "${r.title}" (${r.url})` }
    }
    case 'browser_extract': {
      const text = (await computer.extract()).trim()
      if (!text) return { text: '(page has no visible text)' }
      const offset = numberArg(args.offset, 0, Number.MAX_SAFE_INTEGER)
      const links = offset === 0 ? await linksSection(computer) : ''
      return { text: `${sliceForModel(text, args, 'browser_extract', 'page')}${links}` }
    }
    case 'browser_click': {
      const r = await computer.click(String(args.target ?? ''))
      return { text: `Clicked ${r.clicked}.${r.url ? ` Now on "${r.title ?? ''}" (${r.url}).` : ''}` }
    }
    case 'browser_type': {
      const target = String(args.target ?? '')
      const submit = args.submit === true
      await computer.type(target, String(args.text ?? ''), submit)
      return { text: `Typed into ${target}${submit ? ' and pressed Enter' : ''}.` }
    }
    case 'browser_press': {
      const key = String(args.key ?? '').trim()
      if (!key) return { text: 'browser_press needs a "key".' }
      await computer.press(key)
      return { text: `Pressed ${key}.` }
    }
    case 'browser_scroll': {
      const direction = args.direction === 'up' ? 'up' : 'down'
      await computer.scroll(direction)
      return { text: `Scrolled ${direction}.` }
    }
    case 'browser_back': {
      const r = await computer.back()
      return { text: `Back on "${r.title}" (${r.url})` }
    }
    case 'browser_screenshot': {
      if (!deps.saveShot) return { text: 'Screenshots are not configured on this gateway.' }
      const shot = await computer.screenshot()
      const saved = await deps.saveShot(deps.bot.id, shot)
      const caption = typeof args.caption === 'string' && args.caption.trim() ? args.caption.trim() : undefined
      events.onMessage(insertMessage(deps.db, {
        threadId: deps.threadId, sender: deps.bot.id, kind: 'screenshot',
        payload: caption ? { ...saved, caption } : saved,
      }))
      return { text: 'Screenshot posted to the thread.', image: `data:image/png;base64,${shot.buffer.toString('base64')}` }
    }
    case 'ask_for_login': {
      if (!deps.onAskForLogin) return { text: 'Asking for a takeover is not available on this gateway.' }
      const site = String(args.site ?? '').trim()
      if (!site) return { text: 'ask_for_login needs a "site".' }
      const why = String(args.why ?? '').trim()
      await deps.onAskForLogin({ site, why })
      events.onMessage(insertMessage(deps.db, {
        threadId: deps.threadId, sender: deps.bot.id, kind: 'login_request', payload: { site, why },
      }))
      return { text: `Asked your operator to sign in to ${site}. Stop here until they say it is done.` }
    }
    default:
      return { text: `Unknown tool: ${name}` }
  }
}

function truncate(s: string): string {
  return s.length > MAX_TOOL_CHARS ? `${s.slice(0, MAX_TOOL_CHARS)}\n…(truncated)` : s
}

function describeSteps(payload: unknown): string {
  const steps = (payload as { steps?: ActivityStep[] } | null)?.steps ?? []
  return steps.map((s) => `${s.tool}: ${s.summary}${s.ok === false ? ' (failed)' : ''}`).join('; ')
}

function toChatMsg(m: MessageRow, selfId: string): ChatMsg {
  if (m.sender === 'user') return { role: 'user', content: m.content }
  // 群里别的 bot 说的话是「同事发言」，不能混成自己的历史
  if (m.sender !== selfId) {
    const body = m.kind === 'text'
      ? m.content
      : m.kind === 'activity' ? `[steps taken] ${describeSteps(m.payload)}` : `[${m.kind}] ${JSON.stringify(m.payload)}`
    return { role: 'user', content: `@${m.sender}: ${body}` }
  }
  if (m.kind === 'activity') return { role: 'assistant', content: `[steps taken] ${describeSteps(m.payload)}` }
  if (m.kind === 'report') return { role: 'assistant', content: `[report filed] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'screenshot') return { role: 'assistant', content: '[screenshot posted to the thread]' }
  if (m.kind === 'approval_request') return { role: 'assistant', content: `[held for approval] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'approval_resolved') return { role: 'user', content: `[operator decision] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'memory_updated') return { role: 'assistant', content: `[memory updated] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'routine_created') return { role: 'assistant', content: `[routine created] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'bot_ref') return { role: 'user', content: `[message from teammate] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'login_request') return { role: 'assistant', content: `[asked for a sign-in] ${JSON.stringify(m.payload)}` }
  return { role: 'assistant', content: m.content }
}
