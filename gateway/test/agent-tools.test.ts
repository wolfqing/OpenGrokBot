import { describe, expect, it } from 'vitest'
import { runTurn, type AgentEvents } from '../src/agent.js'
import { createFakeComputer } from '../src/computer.js'
import { ensureDmThread, listMessages, openDb, upsertBot, type MessageRow } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { buildTools } from '../src/tools.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }

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

describe('buildTools', () => {
  it('advertises only the always-on tools without a computer', () => {
    expect(buildTools({ hasComputer: false }).map((t) => t.function.name)).toEqual([
      'message_user', 'hold_for_approval', 'save_memory', 'create_routine',
    ])
  })

  it('advertises the full computer surface when one is attached', () => {
    expect(buildTools({ hasComputer: true }).map((t) => t.function.name)).toEqual([
      'message_user', 'hold_for_approval', 'save_memory', 'create_routine',
      'shell', 'read_file', 'write_file',
      'browser_goto', 'browser_extract', 'browser_click', 'browser_screenshot', 'ask_for_login',
    ])
  })
})

describe('runTurn with a computer', () => {
  it('runs shell and feeds stdout back to the model', async () => {
    const { db, threadId, events } = setup()
    const computer = createFakeComputer()
    const llm = scriptedLLM([toolTurn('shell', { cmd: 'echo hi' }), textTurn])
    await runTurn({ db, llm, bot, soul: '', threadId, getComputer: async () => computer }, 'run it', events)
    expect(computer.calls).toEqual(['shell:echo hi'])
    const toolMsg = llm.calls[1]!.messages.find((m) => m.role === 'tool')
    expect(toolMsg!.content).toContain('exit 0')
    expect(toolMsg!.content).toContain('hi')
  })

  it('navigates, extracts, and posts a screenshot chip to the thread', async () => {
    const { db, threadId, messages, events } = setup()
    const computer = createFakeComputer({ pageText: 'Example Domain body text' })
    const llm = scriptedLLM([
      toolTurn('browser_goto', { url: 'https://example.com' }),
      toolTurn('browser_extract', {}, 'c2'),
      toolTurn('browser_screenshot', { caption: 'the homepage' }, 'c3'),
      textTurn,
    ])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      getComputer: async () => computer,
      saveShot: async () => ({ url: '/api/screenshots/researcher/7.png', width: 1280, height: 800 }),
    }, 'open example.com', events)

    expect(computer.calls).toEqual(['goto:https://example.com', 'extract', 'screenshot'])
    const kinds = listMessages(db, threadId).map((m) => m.kind)
    expect(kinds).toEqual(['text', 'screenshot', 'text'])
    const shotMsg = messages.find((m) => m.kind === 'screenshot')!
    expect(shotMsg.payload).toEqual({ url: '/api/screenshots/researcher/7.png', width: 1280, height: 800, caption: 'the homepage' })
    expect(llm.calls[3]!.messages.some((m) => m.role === 'tool' && m.content === 'Screenshot posted to the thread.')).toBe(true)
  })

  it('reports the failure to the model instead of dying when a tool throws', async () => {
    const { db, threadId, events } = setup()
    const computer = createFakeComputer({ goto: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED') } })
    const llm = scriptedLLM([toolTurn('browser_goto', { url: 'https://nope.invalid' }), textTurn])
    await runTurn({ db, llm, bot, soul: '', threadId, getComputer: async () => computer }, 'go', events)
    const toolMsg = llm.calls[1]!.messages.find((m) => m.role === 'tool')
    expect(toolMsg!.content).toMatch(/ERR_NAME_NOT_RESOLVED/)
    expect(listMessages(db, threadId).map((m) => m.kind)).toEqual(['text', 'text']) // 线程里没留垃圾
  })

  it('tells the model plainly when no computer is attached', async () => {
    const { db, threadId, events } = setup()
    const llm = scriptedLLM([toolTurn('shell', { cmd: 'ls' }), textTurn])
    await runTurn({ db, llm, bot, soul: '', threadId }, 'run it', events)
    const toolMsg = llm.calls[1]!.messages.find((m) => m.role === 'tool')
    expect(toolMsg!.content).toMatch(/no computer/i)
  })

  it('only advertises computer tools when a computer is available', async () => {
    const { db, threadId, events } = setup()
    const withComputer = scriptedLLM([textTurn])
    await runTurn({ db, llm: withComputer, bot, soul: '', threadId, getComputer: async () => createFakeComputer() }, 'hi', events)
    expect((withComputer.calls[0]!.tools as { function: { name: string } }[]).length).toBe(12)

    const without = scriptedLLM([textTurn])
    await runTurn({ db, llm: without, bot, soul: '', threadId }, 'hi', events)
    expect((without.calls[0]!.tools as { function: { name: string } }[]).length).toBe(4)
  })
})
