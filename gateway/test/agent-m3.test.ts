import { describe, expect, it } from 'vitest'
import { runTurn, type AgentEvents } from '../src/agent.js'
import { ensureDmThread, listMessages, openDb, upsertBot, type MessageRow } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { buildTools } from '../src/tools.js'

const bot = { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' }

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
  upsertBot(db, bot)
  const threadId = ensureDmThread(db, bot.id)
  const messages: MessageRow[] = []
  const events: AgentEvents = { onMessage: (m) => messages.push(m), onStatus: () => {} }
  return { db, threadId, messages, events }
}

const toolResult = (llm: { calls: { messages: ChatMsg[] }[] }, at: number) =>
  llm.calls[at]!.messages.find((m) => m.role === 'tool')!.content ?? ''

describe('buildTools', () => {
  it('always offers approval, memory and routine tools', () => {
    expect(buildTools({ hasComputer: false }).map((t) => t.function.name)).toEqual([
      'message_user', 'hold_for_approval', 'save_memory', 'create_routine',
    ])
  })

  it('adds the computer surface on top when one is attached', () => {
    const names = buildTools({ hasComputer: true }).map((t) => t.function.name)
    expect(names).toHaveLength(11)
    expect(names).toContain('browser_screenshot')
    expect(names).toContain('hold_for_approval')
  })
})

describe('hold_for_approval', () => {
  it('posts an approval chip and tells the model to stop', async () => {
    const { db, threadId, messages, events } = setup()
    const llm = scriptedLLM([toolTurn('hold_for_approval', { action: 'send 4 drafts', detail: 'to the Globex thread' }), textTurn])
    await runTurn({ db, llm, bot, soul: '', threadId, onApproval: async () => ({ approvalId: 7 }) }, 'clear my inbox', events)

    const chip = messages.find((m) => m.kind === 'approval_request')!
    expect(chip.payload).toEqual({ approvalId: 7, action: 'send 4 drafts', detail: 'to the Globex thread', status: 'pending' })
    expect(toolResult(llm, 1)).toMatch(/do not perform it/i)
  })

  it('says so plainly when approvals are not wired up', async () => {
    const { db, threadId, events } = setup()
    const llm = scriptedLLM([toolTurn('hold_for_approval', { action: 'send it' }), textTurn])
    await runTurn({ db, llm, bot, soul: '', threadId }, 'go', events)
    expect(toolResult(llm, 1)).toMatch(/not available/i)
  })
})

describe('save_memory', () => {
  it('posts a memory chip carrying the rule and its diff', async () => {
    const { db, threadId, messages, events } = setup()
    const llm = scriptedLLM([toolTurn('save_memory', { rule: 'quiet-account sends wait for your read' }), textTurn])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      onSaveMemory: async (rule) => ({ rule, diff: `+ - ${rule}`, total: 3 }),
    }, 'hold globex until i have read the note', events)

    expect(messages.find((m) => m.kind === 'memory_updated')!.payload).toEqual({
      rule: 'quiet-account sends wait for your read',
      diff: '+ - quiet-account sends wait for your read',
      total: 3,
    })
    expect(toolResult(llm, 1)).toMatch(/saved/i)
  })

  it('reports a duplicate rule without posting a chip', async () => {
    const { db, threadId, messages, events } = setup()
    const llm = scriptedLLM([toolTurn('save_memory', { rule: 'same' }), textTurn])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      onSaveMemory: async (rule) => ({ rule, diff: '', total: 1 }),
    }, 'remember that', events)
    expect(messages.some((m) => m.kind === 'memory_updated')).toBe(false)
    expect(toolResult(llm, 1)).toMatch(/already on file/i)
  })
})

describe('create_routine', () => {
  it('posts a routine chip with the cron in plain English', async () => {
    const { db, threadId, messages, events } = setup()
    const llm = scriptedLLM([
      toolTurn('create_routine', { name: 'Overnight outbound', cron: '0 9 * * *', instructions: 'work the pipeline' }),
      textTurn,
    ])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      onCreateRoutine: async (input) => ({ id: 3, name: input.name, cron: input.cron, human: 'every day at 09:00' }),
    }, 'run this every day', events)

    expect(messages.find((m) => m.kind === 'routine_created')!.payload).toEqual({
      routineId: 3, name: 'Overnight outbound', cron: '0 9 * * *', human: 'every day at 09:00',
    })
    expect(toolResult(llm, 1)).toMatch(/scheduled/i)
  })

  it('pushes an invalid cron back to the model instead of scheduling it', async () => {
    const { db, threadId, messages, events } = setup()
    const llm = scriptedLLM([toolTurn('create_routine', { name: 'Bad', cron: 'every morning', instructions: 'x' }), textTurn])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      onCreateRoutine: async () => { throw new Error('not a valid cron expression: every morning') },
    }, 'schedule it', events)
    expect(messages.some((m) => m.kind === 'routine_created')).toBe(false)
    expect(toolResult(llm, 1)).toMatch(/not a valid cron/i)
  })
})

describe('invisible seeds', () => {
  it('feeds the text to the model without leaving a user bubble', async () => {
    const { db, threadId, messages, events } = setup()
    const llm = scriptedLLM([textTurn])
    await runTurn({ db, llm, bot, soul: '', threadId }, 'Routine "Morning digest" fired.', events, { persistUserMessage: false })

    expect(llm.calls[0]!.messages.some((m) => m.role === 'user' && m.content === 'Routine "Morning digest" fired.')).toBe(true)
    expect(listMessages(db, threadId).map((m) => [m.sender, m.kind])).toEqual([['inbox-keeper', 'text']])
    expect(messages.every((m) => m.sender !== 'user')).toBe(true)
  })
})

describe('standing rules', () => {
  it('carries the bot memory into the system prompt', async () => {
    const { db, threadId, events } = setup()
    const llm = scriptedLLM([textTurn])
    await runTurn({ db, llm, bot, soul: '', threadId, memory: '- quiet accounts wait for your read' }, 'hi', events)
    expect(llm.calls[0]!.messages[0]!.content).toContain('quiet accounts wait for your read')
  })
})
