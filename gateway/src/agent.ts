import { MAX_HOPS } from './a2a.js'
import { canRemember, normalizeKind, normalizeTarget, type ApprovalKind } from './approvals.js'
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

/**
 * 一个回合怎么收场的。网关据此判断这位同事是「卡住了」（出错、超额、步数用完）还是正常停下；
 * 「在等你」不看这里，看库里有没有它没拍板的审批、没回答的问题。
 */
export type TurnOutcome = 'replied' | 'stopped' | 'error' | 'budget' | 'limit'

/** 规则放行时告诉 bot 的：哪条规则、什么时候过期 */
export type RuleGrant = { id: number; kind: ApprovalKind; target: string; expiresAt: number | null }

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
  /** 命中操作者的规则时带回 rule：这次直接放行，bot 当场接着干 */
  onApproval?: (input: { action: string; detail: string; kind: ApprovalKind; target: string }) =>
    Promise<{ approvalId: number; rule?: RuleGrant }>
  onSaveMemory?: (rule: string) => Promise<{ rule: string; diff: string; total: number }>
  onForgetMemory?: (rule: string) => Promise<
    | { removed: string; diff: string; total: number }
    | { removed: null; reason: 'none' | 'ambiguous'; candidates: string[] }
  >
  onCreateRoutine?: (input: { name: string; cron: string; instructions: string; webhook: boolean }) =>
    Promise<{ id: number; name: string; cron: string; human: string; webhook: boolean }>
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
  /** 一个回合最多调几次模型；不传或 ≤0 用默认值 */
  maxSteps?: number
  /** 一个回合最长跑多久（毫秒），在两步之间检查；0 = 不限，不传用默认值 */
  turnTimeoutMs?: number
}

/** 真实的浏览器活（开页、读、点、再读、填）十几步就用完了；40 步够干完一件事，又挡得住死循环 */
export const DEFAULT_MAX_STEPS = 40
export const DEFAULT_TURN_MS = 20 * 60_000
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
  opts: {
    persistUserMessage?: boolean
    alreadyStored?: boolean
    /** 这一轮要回答的、排队时就已落库的用户消息：挪到上下文末尾，它们才是「最新说的话」 */
    pendingIds?: number[]
    /** 还在排队等自己那一轮的用户消息：别的回合（routine、放行、转交）看不到，免得被顺手答掉 */
    hiddenIds?: number[]
  } = {},
): Promise<TurnOutcome> {
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
      ...orderHistory(listMessages(db, threadId, HISTORY_LIMIT), opts.pendingIds, opts.hiddenIds)
        .map((m) => toChatMsg(m, bot.id)),
    ]
    // routine 触发 / 审批放行 / 群发言不落库，但模型必须看到这句话才知道要干什么
    if (!persistUserMessage && !alreadyStored) history.push({ role: 'user', content: userText })
    const now = (deps.now ?? (() => new Date()))()
    const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const messages = withTimeNote(history, timeNote(now, timeZone))
    const tools = buildTools({ hasComputer, canRelay })
    const maxSteps = deps.maxSteps && deps.maxSteps > 0 ? Math.floor(deps.maxSteps) : DEFAULT_MAX_STEPS
    const turnMs = deps.turnTimeoutMs ?? DEFAULT_TURN_MS
    const startedAt = Date.now()
    for (let step = 0; ; step++) {
      if (signal?.aborted) return stopped(say)
      const limit = step >= maxSteps ? stepLimit(maxSteps)
        : turnMs > 0 && Date.now() - startedAt >= turnMs ? timeLimit(turnMs) : null
      if (limit) return await closeOut(deps, messages, tools, limit, say)
      const overBudget = deps.checkBudget?.()
      if (overBudget) {
        say(overBudget)
        return 'budget'
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
      return 'replied'
    }
  } catch (err) {
    if (signal?.aborted) return stopped(say)
    say(`⚠️ ${bot.name} hit an error: ${err instanceof Error ? err.message : String(err)}`)
    return 'error'
  } finally {
    activity.close()
    events.onStatus(bot.id, 'idle')
  }
}

function orderHistory(rows: MessageRow[], pendingIds: number[] = [], hiddenIds: number[] = []): MessageRow[] {
  const pending = new Set(pendingIds)
  const hidden = new Set(hiddenIds)
  const rest = rows.filter((m) => !pending.has(m.id) && !hidden.has(m.id))
  return [...rest, ...rows.filter((m) => pending.has(m.id))]
}

function stopped(say: (content: string) => void): 'stopped' {
  say('⏹ Stopped. Tell me when to pick it back up.')
  return 'stopped'
}

const stepLimit = (n: number) => `the ${n}-step limit for one turn`
const timeLimit = (ms: number) =>
  `the ${ms >= 60_000 ? `${Math.round(ms / 60_000)}-minute` : `${Math.max(1, Math.round(ms / 1000))}-second`} limit for one turn`

/**
 * 撞到步数或时长上限：不是甩一句「停了」，而是再问模型一次（只许回文字），让它交代做完了什么、还剩什么。
 * 这一次也算预算；它失败了就只留那句说明。
 */
async function closeOut(
  deps: AgentDeps,
  messages: ChatMsg[],
  tools: ReturnType<typeof buildTools>,
  limit: string,
  say: (content: string) => void,
): Promise<TurnOutcome> {
  const notice = `⏸ Paused at ${limit}. Say "continue" to pick it up.`
  const overBudget = deps.checkBudget?.()
  if (overBudget) {
    say(overBudget)
    return 'budget'
  }
  try {
    messages.push({
      role: 'user',
      content: `[gateway] You have reached ${limit}. Do not call any tools. In a few plain lines: what you finished, `
        + 'what is left, and anything you need from your operator.',
    })
    const turn = await deps.llm.chat(messages, tools, { signal: deps.signal, toolChoice: 'none' })
    if (turn.usage) deps.onUsage?.(turn.usage)
    const text = turn.content?.trim()
    say(text ? `${text}\n\n${notice}` : notice)
  } catch {
    if (deps.signal?.aborted) return stopped(say)
    say(notice)
  }
  return 'limit'
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

const WORKFLOW_TOOL_NAMES = new Set([
  'hold_for_approval', 'ask_operator', 'save_memory', 'forget_memory', 'create_routine', 'stop_routine', 'message_bot',
])

const MAX_OPTIONS = 6
const MAX_OPTION_CHARS = 80

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
      const kind = normalizeKind(args.kind)
      const target = normalizeTarget(args.target)
      const { approvalId, rule } = await deps.onApproval({ action, detail, kind, target })
      events.onMessage(insertMessage(deps.db, {
        threadId: deps.threadId, sender: deps.bot.id, kind: 'approval_request',
        payload: {
          approvalId, action, detail, kind, target,
          status: rule ? 'approved' : 'pending',
          ...(rule ? { rule } : { canRemember: canRemember({ kind, target }) }),
        },
      }))
      if (rule) {
        return `Pre-approved by your operator's standing rule #${rule.id} (${kind} → ${target}). `
          + 'Go ahead now, exactly as held, then report what actually happened.'
      }
      return "Held for your operator's approval. Stop here — do not perform it."
    }
    case 'ask_operator': {
      const question = String(args.question ?? '').trim()
      const raw = Array.isArray(args.options) ? args.options : []
      const options = [...new Set(raw.map((o) => String(o ?? '').trim().slice(0, MAX_OPTION_CHARS)).filter(Boolean))]
      if (!question) return 'ask_operator needs a one-line "question".'
      if (options.length < 2 || options.length > MAX_OPTIONS) {
        return `ask_operator needs 2 to ${MAX_OPTIONS} distinct options; for an open question, just ask in plain text.`
      }
      events.onMessage(insertMessage(deps.db, {
        threadId: deps.threadId, sender: deps.bot.id, kind: 'question',
        payload: { question, options, multi: args.multi === true, status: 'open' },
      }))
      return 'Question posted as a card. Stop here and wait for the answer — do not guess it.'
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
    case 'forget_memory': {
      if (!deps.onForgetMemory) return 'Memory is not available on this gateway.'
      const rule = String(args.rule ?? '').trim()
      if (!rule) return 'forget_memory needs the "rule" to remove.'
      const result = await deps.onForgetMemory(rule)
      if (result.removed === null) {
        const list = result.candidates.map((c) => `- ${c}`).join('\n')
        if (result.reason === 'ambiguous') return `Several rules match; nothing was removed. Ask which one:\n${list}`
        return list ? `No rule like that is on file. Your standing rules:\n${list}` : 'You have no standing rules on file.'
      }
      events.onMessage(insertMessage(deps.db, {
        threadId: deps.threadId, sender: deps.bot.id, kind: 'memory_updated',
        payload: { rule: result.removed, diff: result.diff, total: result.total, removed: true },
      }))
      return `Removed from MEMORY.md: "${result.removed}".`
    }
    case 'create_routine': {
      if (!deps.onCreateRoutine) return 'Routines are not available on this gateway.'
      const routineName = String(args.name ?? '').trim()
      const cron = String(args.cron ?? '').trim()
      const webhook = args.webhook === true
      const instructions = String(args.instructions ?? '').trim()
      if (!routineName || !instructions) return 'create_routine needs "name" and "instructions".'
      if (!cron && !webhook) return 'create_routine needs a "cron" schedule, "webhook": true, or both.'
      const routine = await deps.onCreateRoutine({ name: routineName, cron, instructions, webhook })
      // webhook 的密钥只在操作者的电脑面板里出现，不进线程、也就不进模型的上下文
      events.onMessage(insertMessage(deps.db, {
        threadId: deps.threadId, sender: deps.bot.id, kind: 'routine_created',
        payload: { routineId: routine.id, name: routine.name, cron: routine.cron, human: routine.human, webhook: routine.webhook },
      }))
      return `Routine "${routine.name}" ${routine.cron ? 'scheduled' : 'set up'} (${routine.human}).`
        + (routine.webhook ? ' Your operator copies its webhook address from your computer panel.' : '')
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

const DEFAULT_SHELL_MS = 60_000
const MAX_SHELL_MS = 600_000

/** 模型给 0（不限时）或天文数字也不行：一条命令最多占着这位同事十分钟 */
function shellTimeout(value: unknown): number {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_SHELL_MS
  return Math.min(ms, MAX_SHELL_MS)
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
      const r = await computer.shell(String(args.cmd ?? ''), shellTimeout(args.timeoutMs), deps.signal)
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
  // 放行/驳回是操作者发的、但没有正文：写成一句话，别给模型一条空的 user 消息（有的服务商会直接 400）
  if (m.kind === 'approval_resolved') return { role: 'user', content: `[operator decision] ${JSON.stringify(m.payload)}` }
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
  if (m.kind === 'memory_updated') return { role: 'assistant', content: `[memory updated] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'routine_created') return { role: 'assistant', content: `[routine created] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'bot_ref') return { role: 'user', content: `[message from teammate] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'login_request') return { role: 'assistant', content: `[asked for a sign-in] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'question') return { role: 'assistant', content: `[asked your operator] ${JSON.stringify(m.payload)}` }
  return { role: 'assistant', content: m.content }
}
