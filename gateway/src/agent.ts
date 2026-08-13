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
}

const MAX_STEPS = 12
const HISTORY_LIMIT = 40
const MAX_TOOL_CHARS = 4000

export async function runTurn(deps: AgentDeps, userText: string, events: AgentEvents): Promise<void> {
  const { db, llm, bot, soul, threadId } = deps
  const hasComputer = Boolean(deps.getComputer)
  events.onMessage(insertMessage(db, { threadId, sender: 'user', kind: 'text', content: userText }))
  events.onStatus(bot.id, 'thinking')
  try {
    const messages: ChatMsg[] = [
      { role: 'system', content: buildSystemPrompt(bot, soul, hasComputer) },
      ...listMessages(db, threadId, HISTORY_LIMIT).map(toChatMsg),
    ]
    const tools = buildTools(hasComputer)
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

async function execToolCall(deps: AgentDeps, call: ToolCall, events: AgentEvents): Promise<string> {
  const args = (call.args ?? {}) as Record<string, unknown>
  if (call.name === 'message_user') return execMessageUser(deps, args, events)
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
  return { role: 'assistant', content: m.content }
}
