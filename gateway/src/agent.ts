import { insertMessage, listMessages, type BotRow, type Db, type MessageRow } from './db.js'
import type { ChatMsg, LLM, ToolCall } from './llm.js'
import { buildSystemPrompt } from './prompts.js'
import { validateReportPayload } from './report.js'
import { MESSAGE_USER_TOOL } from './tools.js'

export type AgentEvents = {
  onMessage: (m: MessageRow) => void
  onStatus: (botId: string, state: 'thinking' | 'idle') => void
}

export type AgentDeps = { db: Db; llm: LLM; bot: BotRow; soul: string; threadId: string }

const MAX_STEPS = 6
const HISTORY_LIMIT = 40

export async function runTurn(deps: AgentDeps, userText: string, events: AgentEvents): Promise<void> {
  const { db, llm, bot, soul, threadId } = deps
  events.onMessage(insertMessage(db, { threadId, sender: 'user', kind: 'text', content: userText }))
  events.onStatus(bot.id, 'thinking')
  try {
    const messages: ChatMsg[] = [
      { role: 'system', content: buildSystemPrompt(bot, soul) },
      ...listMessages(db, threadId, HISTORY_LIMIT).map(toChatMsg),
    ]
    for (let step = 0; step < MAX_STEPS; step++) {
      const turn = await llm.chat(messages, [MESSAGE_USER_TOOL])
      if (turn.toolCalls.length > 0) {
        messages.push(turn.raw)
        for (const call of turn.toolCalls) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: execToolCall(deps, call, events) })
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

function execToolCall(deps: AgentDeps, call: ToolCall, events: AgentEvents): string {
  if (call.name !== 'message_user') return `Unknown tool: ${call.name}`
  const args = (call.args ?? {}) as { kind?: unknown; payload?: unknown }
  if (args.kind !== 'report') return 'Unsupported kind; only "report" exists today.'
  const payload = validateReportPayload(args.payload)
  if (!payload) return 'Invalid report payload: need lines[] of {system, result, count?} plus optional closing.'
  events.onMessage(insertMessage(deps.db, { threadId: deps.threadId, sender: deps.bot.id, kind: 'report', payload }))
  return 'Report delivered.'
}

function toChatMsg(m: MessageRow): ChatMsg {
  if (m.sender === 'user') return { role: 'user', content: m.content }
  if (m.kind === 'report') return { role: 'assistant', content: `[report filed] ${JSON.stringify(m.payload)}` }
  return { role: 'assistant', content: m.content }
}
