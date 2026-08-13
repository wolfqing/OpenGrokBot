import { describe, expect, it } from 'vitest'
import { runTurn, type AgentEvents } from '../src/agent.js'
import { ensureDmThread, listMessages, openDb, upsertBot, type MessageRow } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }

function scriptedLLM(script: AssistantTurn[]): LLM & { calls: ChatMsg[][] } {
  const calls: ChatMsg[][] = []
  return {
    calls,
    async chat(messages) {
      calls.push([...messages])
      const next = script.shift()
      if (!next) throw new Error('script exhausted')
      return next
    },
  }
}

function collector() {
  const messages: MessageRow[] = []
  const statuses: string[] = []
  const events: AgentEvents = {
    onMessage: (m) => messages.push(m),
    onStatus: (_id, s) => statuses.push(s),
  }
  return { messages, statuses, events }
}

function setup() {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  const threadId = ensureDmThread(db, bot.id)
  return { db, threadId }
}

const reportCall: AssistantTurn = {
  content: null,
  toolCalls: [{
    id: 'c1',
    name: 'message_user',
    args: { kind: 'report', payload: { lines: [{ system: 'Web', result: 'scanned', count: '3 pages' }], closing: 'nothing needs you' } },
  }],
  raw: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'message_user', arguments: '{}' } }] },
}
const textTurn: AssistantTurn = { content: 'Done for today.', toolCalls: [], raw: { role: 'assistant', content: 'Done for today.' } }

describe('runTurn', () => {
  it('persists user msg, report chip, closing text; emits statuses', async () => {
    const { db, threadId } = setup()
    const llm = scriptedLLM([reportCall, textTurn])
    const { messages, statuses, events } = collector()
    await runTurn({ db, llm, bot, soul: 'You are Scout.', threadId }, 'scan the web', events)
    const rows = listMessages(db, threadId)
    expect(rows.map((r) => [r.sender, r.kind])).toEqual([
      ['user', 'text'], ['researcher', 'report'], ['researcher', 'text'],
    ])
    expect((rows[1]!.payload as { closing: string }).closing).toBe('nothing needs you')
    expect(messages).toHaveLength(3) // 全部实时广播
    expect(statuses).toEqual(['thinking', 'idle'])
    // 系统提示词进了首条消息，tool 结果按 OpenAI 协议回传
    expect(llm.calls[0]![0]!.role).toBe('system')
    expect(llm.calls[1]!.some((m) => m.role === 'tool' && m.content === 'Report delivered.')).toBe(true)
  })

  it('plain text reply works without tools', async () => {
    const { db, threadId } = setup()
    const { messages, events } = collector()
    await runTurn({ db, llm: scriptedLLM([textTurn]), bot, soul: '', threadId }, 'hi', events)
    expect(messages.map((m) => m.kind)).toEqual(['text', 'text'])
    expect(messages[1]!.content).toBe('Done for today.')
  })

  it('feeds validation error back to model on bad payload, model retries', async () => {
    const { db, threadId } = setup()
    const badCall: AssistantTurn = {
      content: null,
      toolCalls: [{ id: 'c9', name: 'message_user', args: { kind: 'report', payload: { lines: [] } } }],
      raw: { role: 'assistant', content: null, tool_calls: [] },
    }
    const llm = scriptedLLM([badCall, textTurn])
    const { events } = collector()
    await runTurn({ db, llm, bot, soul: '', threadId }, 'go', events)
    expect(llm.calls[1]!.some((m) => m.role === 'tool' && /Invalid report payload/.test(m.content ?? ''))).toBe(true)
    expect(listMessages(db, threadId).map((r) => r.kind)).toEqual(['text', 'text']) // 无 report 落库
  })

  it('turns llm errors into a visible bot message and goes idle', async () => {
    const { db, threadId } = setup()
    const { messages, statuses, events } = collector()
    const failing: LLM = { chat: async () => { throw new Error('LLM API 429: quota') } }
    await runTurn({ db, llm: failing, bot, soul: '', threadId }, 'go', events)
    expect(messages[1]!.content).toContain('429')
    expect(statuses).toEqual(['thinking', 'idle'])
  })
})
