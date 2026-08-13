import type { BotComputer, Shot } from './computer.js'
import { insertMessage, listMessages, type BotRow, type Db, type MessageRow } from './db.js'
import type { ChatMsg, LLM, ToolCall } from './llm.js'
import { buildSystemPrompt } from './prompts.js'
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
  onApproval?: (input: { action: string; detail: string }) => Promise<{ approvalId: number }>
  onSaveMemory?: (rule: string) => Promise<{ rule: string; diff: string; total: number }>
  onCreateRoutine?: (input: { name: string; cron: string; instructions: string }) =>
    Promise<{ id: number; name: string; cron: string; human: string }>
}

const MAX_STEPS = 12
const HISTORY_LIMIT = 40
const MAX_TOOL_CHARS = 4000

export async function runTurn(
  deps: AgentDeps,
  userText: string,
  events: AgentEvents,
  opts: { persistUserMessage?: boolean } = {},
): Promise<void> {
  const { db, llm, bot, soul, threadId } = deps
  const hasComputer = Boolean(deps.getComputer)
  const persistUserMessage = opts.persistUserMessage !== false
  if (persistUserMessage) {
    events.onMessage(insertMessage(db, { threadId, sender: 'user', kind: 'text', content: userText }))
  }
  events.onStatus(bot.id, 'thinking')
  try {
    const messages: ChatMsg[] = [
      { role: 'system', content: buildSystemPrompt(bot, soul, { hasComputer, memory: deps.memory }) },
      ...listMessages(db, threadId, HISTORY_LIMIT).map(toChatMsg),
    ]
    // routine 触发 / 审批放行不落库，但模型必须看到这句话才知道要干什么
    if (!persistUserMessage) messages.push({ role: 'user', content: userText })
    const tools = buildTools({ hasComputer })
    for (let step = 0; step < MAX_STEPS; step++) {
      const turn = await llm.chat(messages, tools)
      if (turn.toolCalls.length > 0) {
        messages.push(turn.raw)
        for (const call of turn.toolCalls) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: await execToolCall(deps, call, events) })
        }
        continue
      }
      const text = turn.content?.trim()
      if (text) events.onMessage(insertMessage(db, { threadId, sender: bot.id, kind: 'text', content: text }))
      return
    }
    events.onMessage(insertMessage(db, {
      threadId, sender: bot.id, kind: 'text',
      content: `⚠️ ${bot.name} stopped after ${MAX_STEPS} steps without a final reply.`,
    }))
  } catch (err) {
    events.onMessage(insertMessage(db, {
      threadId, sender: bot.id, kind: 'text',
      content: `⚠️ ${bot.name} hit an error: ${err instanceof Error ? err.message : String(err)}`,
    }))
  } finally {
    events.onStatus(bot.id, 'idle')
  }
}

const COMPUTER_TOOL_NAMES = new Set([
  'shell', 'read_file', 'write_file', 'browser_goto', 'browser_extract', 'browser_click', 'browser_screenshot',
])

const WORKFLOW_TOOL_NAMES = new Set(['hold_for_approval', 'save_memory', 'create_routine'])

async function execToolCall(deps: AgentDeps, call: ToolCall, events: AgentEvents): Promise<string> {
  const args = (call.args ?? {}) as Record<string, unknown>
  if (call.name === 'message_user') return execMessageUser(deps, args, events)
  if (WORKFLOW_TOOL_NAMES.has(call.name)) {
    try {
      return truncate(await execWorkflowTool(deps, call.name, args, events))
    } catch (err) {
      return `Tool ${call.name} failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (!COMPUTER_TOOL_NAMES.has(call.name)) return `Unknown tool: ${call.name}`
  if (!deps.getComputer) return 'You have no computer attached right now — this tool is unavailable.'
  try {
    return truncate(await execComputerTool(deps, call.name, args, events))
  } catch (err) {
    // 工具失败必须回喂模型（让它换招/如实汇报），而不是炸掉整个回合
    return `Tool ${call.name} failed: ${err instanceof Error ? err.message : String(err)}`
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
    default:
      return `Unknown tool: ${name}`
  }
}

async function execComputerTool(
  deps: AgentDeps,
  name: string,
  args: Record<string, unknown>,
  events: AgentEvents,
): Promise<string> {
  const computer = await deps.getComputer!()
  switch (name) {
    case 'shell': {
      const r = await computer.shell(String(args.cmd ?? ''), typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined)
      return [`exit ${r.exitCode}`, r.stdout.trim(), r.stderr.trim() ? `stderr:\n${r.stderr.trim()}` : '']
        .filter(Boolean).join('\n')
    }
    case 'read_file':
      return computer.readFile(String(args.path ?? ''))
    case 'write_file':
      await computer.writeFile(String(args.path ?? ''), String(args.content ?? ''))
      return `Wrote ${String(args.path ?? '')}.`
    case 'browser_goto': {
      const r = await computer.goto(String(args.url ?? ''))
      return `Now on "${r.title}" (${r.url})`
    }
    case 'browser_extract':
      return (await computer.extract(typeof args.maxChars === 'number' ? args.maxChars : MAX_TOOL_CHARS)) || '(page has no visible text)'
    case 'browser_click': {
      const r = await computer.click(String(args.target ?? ''))
      return `Clicked ${r.clicked}.`
    }
    case 'browser_screenshot': {
      if (!deps.saveShot) return 'Screenshots are not configured on this gateway.'
      const saved = await deps.saveShot(deps.bot.id, await computer.screenshot())
      const caption = typeof args.caption === 'string' && args.caption.trim() ? args.caption.trim() : undefined
      events.onMessage(insertMessage(deps.db, {
        threadId: deps.threadId, sender: deps.bot.id, kind: 'screenshot',
        payload: caption ? { ...saved, caption } : saved,
      }))
      return 'Screenshot posted to the thread.'
    }
    default:
      return `Unknown tool: ${name}`
  }
}

function truncate(s: string): string {
  return s.length > MAX_TOOL_CHARS ? `${s.slice(0, MAX_TOOL_CHARS)}\n…(truncated)` : s
}

function toChatMsg(m: MessageRow): ChatMsg {
  if (m.sender === 'user') return { role: 'user', content: m.content }
  if (m.kind === 'report') return { role: 'assistant', content: `[report filed] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'screenshot') return { role: 'assistant', content: '[screenshot posted to the thread]' }
  if (m.kind === 'approval_request') return { role: 'assistant', content: `[held for approval] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'approval_resolved') return { role: 'user', content: `[operator decision] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'memory_updated') return { role: 'assistant', content: `[memory updated] ${JSON.stringify(m.payload)}` }
  if (m.kind === 'routine_created') return { role: 'assistant', content: `[routine created] ${JSON.stringify(m.payload)}` }
  return { role: 'assistant', content: m.content }
}
