import { describe, expect, it } from 'vitest'
import { runTurn, type AgentEvents } from '../src/agent.js'
import { ensureDmThread, ensureGroupThread, insertMessage, openDb, upsertBot, type MessageRow } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { buildTools } from '../src/tools.js'

const scout = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const ticker = { id: 'market-watch', name: 'Ticker', role: 'markets', emoji: '📈', soul_path: '' }

function scriptedLLM(script: AssistantTurn[]): LLM & { calls: { messages: ChatMsg[]; tools: unknown[] }[] } {
  const calls: { messages: ChatMsg[]; tools: unknown[] }[] = []
  return {
    calls,
    async chat(messages, tools) {
      calls.push({ messages: [...messages], tools })
      const next = script.shift()
      if (!next) throw new Error('script exhausted')
      return next
    },
  }
}
function toolTurn(name: string, args: unknown, id = 'c1'): AssistantTurn {
  return { content: null, toolCalls: [{ id, name, args }], raw: { role: 'assistant', content: null, tool_calls: [] } }
}
const textTurn: AssistantTurn = { content: 'Done.', toolCalls: [], raw: { role: 'assistant', content: 'Done.' } }

function setup() {
  const db = openDb(':memory:')
  upsertBot(db, scout)
  upsertBot(db, ticker)
  const threadId = ensureDmThread(db, scout.id)
  const messages: MessageRow[] = []
  const events: AgentEvents = { onMessage: (m) => messages.push(m), onStatus: () => {} }
  return { db, threadId, messages, events }
}
const toolResult = (llm: { calls: { messages: ChatMsg[] }[] }, at: number) =>
  llm.calls[at]!.messages.find((m) => m.role === 'tool')!.content ?? ''

describe('buildTools', () => {
  it('adds message_bot only when relaying is allowed', () => {
    expect(buildTools({ hasComputer: false, canRelay: false }).map((t) => t.function.name)).not.toContain('message_bot')
    expect(buildTools({ hasComputer: false, canRelay: true }).map((t) => t.function.name)).toContain('message_bot')
  })
})

describe('message_bot', () => {
  it('hands work to a teammate and reports who took it', async () => {
    const { db, threadId, events } = setup()
    const llm = scriptedLLM([toolTurn('message_bot', { to: 'market-watch', content: 'price the Turso tiers' }), textTurn])
    const handed: { to: string; content: string }[] = []
    await runTurn({
      db, llm, bot: scout, soul: '', threadId,
      onMessageBot: async (input) => { handed.push(input); return { delivered: true, toName: 'Ticker' } },
    }, 'compare turso', events)
    expect(handed).toEqual([{ to: 'market-watch', content: 'price the Turso tiers' }])
    expect(toolResult(llm, 1)).toMatch(/handed to ticker/i)
  })

  it('passes the allowlist refusal back to the model', async () => {
    const { db, threadId, events } = setup()
    const llm = scriptedLLM([toolTurn('message_bot', { to: 'market-watch', content: 'do it' }), textTurn])
    await runTurn({
      db, llm, bot: scout, soul: '', threadId,
      onMessageBot: async () => ({ delivered: false, reason: 'Messaging market-watch is not allowlisted for you.' }),
    }, 'hand it over', events)
    expect(toolResult(llm, 1)).toMatch(/not allowlisted/i)
  })

  it('refuses to relay past the hop limit', async () => {
    const { db, threadId, events } = setup()
    const llm = scriptedLLM([toolTurn('message_bot', { to: 'market-watch', content: 'again' }), textTurn])
    let called = false
    await runTurn({
      db, llm, bot: scout, soul: '', threadId, hop: 2,
      onMessageBot: async () => { called = true; return { delivered: true } },
    }, 'keep passing', events)
    expect(called).toBe(false)
    expect(toolResult(llm, 1)).toMatch(/relay limit/i)
  })

  it('says so when relaying is not configured at all', async () => {
    const { db, threadId, events } = setup()
    const llm = scriptedLLM([toolTurn('message_bot', { to: 'market-watch', content: 'x' }), textTurn])
    await runTurn({ db, llm, bot: scout, soul: '', threadId }, 'hand it over', events)
    expect(toolResult(llm, 1)).toMatch(/not available/i)
  })
})

describe('speaker-aware history', () => {
  it('shows another bot as a speaker, not as the bot own past self', async () => {
    const { db, events } = setup()
    const groupId = ensureGroupThread(db, 'group:offsite-crew', 'Offsite crew', ['researcher', 'market-watch'])
    insertMessage(db, { threadId: groupId, sender: 'user', kind: 'text', content: 'where are we?' })
    insertMessage(db, { threadId: groupId, sender: 'market-watch', kind: 'text', content: 'markets are flat' })
    const llm = scriptedLLM([textTurn])
    await runTurn({
      db, llm, bot: scout, soul: '', threadId: groupId,
      group: { title: 'Offsite crew', members: ['Scout', 'Ticker'] },
    }, 'your turn', events, { persistUserMessage: false })

    const history = llm.calls[0]!.messages
    const fromTicker = history.find((m) => (m.content ?? '').includes('markets are flat'))!
    expect(fromTicker.role).toBe('user')
    expect(fromTicker.content).toContain('@market-watch:')
    expect(history[0]!.content).toContain('Offsite crew') // 群纪律进了系统提示词
  })

  it('keeps the bot own earlier lines as its own assistant history', async () => {
    const { db, events } = setup()
    const groupId = ensureGroupThread(db, 'group:offsite-crew', 'Offsite crew', ['researcher', 'market-watch'])
    insertMessage(db, { threadId: groupId, sender: 'researcher', kind: 'text', content: 'brief is done' })
    const llm = scriptedLLM([textTurn])
    await runTurn({ db, llm, bot: scout, soul: '', threadId: groupId }, 'again', events, { persistUserMessage: false })
    const own = llm.calls[0]!.messages.find((m) => (m.content ?? '').includes('brief is done'))!
    expect(own.role).toBe('assistant')
    expect(own.content).not.toContain('@')
  })
})
