import { describe, expect, it } from 'vitest'
import { runTurn, type AgentEvents } from '../src/agent.js'
import { createFakeComputer } from '../src/computer.js'
import { ensureDmThread, openDb, upsertBot, type MessageRow } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { buildTools } from '../src/tools.js'

const bot = { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' }

function scriptedLLM(script: AssistantTurn[]): LLM & { calls: { messages: ChatMsg[] }[] } {
  const calls: { messages: ChatMsg[] }[] = []
  return {
    calls,
    async chat(messages) {
      calls.push({ messages: [...messages] })
      const next = script.shift()
      if (!next) throw new Error('script exhausted')
      return next
    },
  }
}
function toolTurn(name: string, args: unknown): AssistantTurn {
  return { content: null, toolCalls: [{ id: 'c1', name, args }], raw: { role: 'assistant', content: null, tool_calls: [] } }
}
const textTurn: AssistantTurn = { content: 'Waiting.', toolCalls: [], raw: { role: 'assistant', content: 'Waiting.' } }

function setup() {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  const threadId = ensureDmThread(db, bot.id)
  const messages: MessageRow[] = []
  const events: AgentEvents = { onMessage: (m) => messages.push(m), onStatus: () => {} }
  return { db, threadId, messages, events }
}
const toolResult = (llm: { calls: { messages: ChatMsg[] }[] }, at: number) =>
  llm.calls[at]!.messages.find((m) => m.role === 'tool')!.content ?? ''

describe('ask_for_login', () => {
  it('is offered only when the bot has a computer', () => {
    expect(buildTools({ hasComputer: false }).map((t) => t.function.name)).not.toContain('ask_for_login')
    expect(buildTools({ hasComputer: true }).map((t) => t.function.name)).toContain('ask_for_login')
  })

  it('posts a login chip and tells the bot to wait', async () => {
    const { db, threadId, messages, events } = setup()
    const llm = scriptedLLM([toolTurn('ask_for_login', { site: 'Zendesk', why: 'to work the support queue' }), textTurn])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      getComputer: async () => createFakeComputer(),
      onAskForLogin: async () => {},
    }, 'clear the queue', events)

    expect(messages.find((m) => m.kind === 'login_request')!.payload)
      .toEqual({ site: 'Zendesk', why: 'to work the support queue' })
    expect(toolResult(llm, 1)).toMatch(/sign in to zendesk/i)
    expect(toolResult(llm, 1)).toMatch(/stop here/i)
  })

  it('needs a site', async () => {
    const { db, threadId, messages, events } = setup()
    const llm = scriptedLLM([toolTurn('ask_for_login', { why: 'because' }), textTurn])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      getComputer: async () => createFakeComputer(),
      onAskForLogin: async () => {},
    }, 'go', events)
    expect(messages.some((m) => m.kind === 'login_request')).toBe(false)
    expect(toolResult(llm, 1)).toMatch(/needs a "site"/i)
  })

  it('tells the model plainly when takeovers are not wired up', async () => {
    const { db, threadId, events } = setup()
    const llm = scriptedLLM([toolTurn('ask_for_login', { site: 'Zendesk' }), textTurn])
    await runTurn({ db, llm, bot, soul: '', threadId, getComputer: async () => createFakeComputer() }, 'go', events)
    expect(toolResult(llm, 1)).toMatch(/not available/i)
  })

  it('never invites the bot to ask for a password in chat', () => {
    const briefing = buildTools({ hasComputer: true }).find((t) => t.function.name === 'ask_for_login')!
    expect(briefing.function.description).toMatch(/never have their credentials/i)
  })
})
