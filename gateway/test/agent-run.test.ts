import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_STEPS, runTurn, type AgentEvents } from '../src/agent.js'
import { createFakeComputer } from '../src/computer.js'
import { ensureDmThread, insertMessage, listMessages, openDb, upsertBot, type MessageRow } from '../src/db.js'
import type { AssistantTurn, ChatMsg, ChatOptions, LLM, Usage } from '../src/llm.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }

function scriptedLLM(script: AssistantTurn[], onCall?: (n: number) => void) {
  const calls: { messages: ChatMsg[]; opts?: ChatOptions }[] = []
  const llm: LLM = {
    async chat(messages, _tools, opts) {
      calls.push({ messages: messages.map((m) => ({ ...m })), opts })
      onCall?.(calls.length)
      const next = script.shift()
      if (!next) throw new Error('script exhausted')
      return next
    },
  }
  return { llm, calls }
}

const toolTurn = (name: string, args: unknown, id = 'c1'): AssistantTurn =>
  ({ content: null, toolCalls: [{ id, name, args }], raw: { role: 'assistant', content: null, tool_calls: [] } })
const textTurn = (content = 'Done.', usage?: Usage): AssistantTurn =>
  ({ content, toolCalls: [], raw: { role: 'assistant', content }, ...(usage ? { usage } : {}) })
const report = { kind: 'report', payload: { lines: [{ system: 'Web', result: 'scanned' }] } }

function setup() {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  const threadId = ensureDmThread(db, bot.id)
  const messages: MessageRow[] = []
  const events: AgentEvents = { onMessage: (m) => messages.push(m), onStatus: () => {} }
  return { db, threadId, messages, events }
}

describe('stopping a turn', () => {
  it('stops before the next model call once the operator hits stop', async () => {
    const { db, threadId, events } = setup()
    const stop = new AbortController()
    const { llm, calls } = scriptedLLM([toolTurn('message_user', report), textTurn()], (n) => { if (n === 1) stop.abort() })
    await runTurn({ db, llm, bot, soul: '', threadId, signal: stop.signal }, 'go', events)
    expect(calls).toHaveLength(1)
    const last = listMessages(db, threadId).at(-1)!
    expect(last.content).toMatch(/stopped/i)
    expect(last.content).not.toMatch(/error/i)
  })

  it('treats an abort during the model call as a stop, not an error', async () => {
    const { db, threadId, events } = setup()
    const stop = new AbortController()
    const llm: LLM = {
      chat: (_m, _t, opts) => new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        stop.abort()
      }),
    }
    await runTurn({ db, llm, bot, soul: '', threadId, signal: stop.signal }, 'go', events)
    expect(listMessages(db, threadId).at(-1)!.content).toMatch(/^⏹/)
  })

  it('hands the stop signal to the model call', async () => {
    const { db, threadId, events } = setup()
    const stop = new AbortController()
    const { llm, calls } = scriptedLLM([textTurn()])
    await runTurn({ db, llm, bot, soul: '', threadId, signal: stop.signal }, 'go', events)
    expect(calls[0]!.opts?.signal).toBe(stop.signal)
  })
})

describe('usage and budget', () => {
  it('reports the usage of every model call', async () => {
    const { db, threadId, events } = setup()
    const seen: Usage[] = []
    const usage = { prompt: 900, completion: 40, cached: 512 }
    const { llm } = scriptedLLM([{ ...toolTurn('message_user', report), usage }, textTurn('ok', usage)])
    await runTurn({ db, llm, bot, soul: '', threadId, onUsage: (u) => { seen.push(u) } }, 'go', events)
    expect(seen).toEqual([usage, usage])
  })

  it('refuses to call the model once the budget is spent, and says why', async () => {
    const { db, threadId, events } = setup()
    const { llm, calls } = scriptedLLM([textTurn()])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      checkBudget: () => '⚠️ Scout hit today\'s token budget (200,000). It picks up again tomorrow.',
    }, 'go', events)
    expect(calls).toHaveLength(0)
    expect(listMessages(db, threadId).at(-1)!.content).toMatch(/token budget/)
  })

  it('stops mid-turn when the budget runs out between steps', async () => {
    const { db, threadId, events } = setup()
    let checks = 0
    const { llm, calls } = scriptedLLM([toolTurn('message_user', report), textTurn()])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      checkBudget: () => (++checks > 1 ? 'budget spent' : null),
    }, 'go', events)
    expect(calls).toHaveLength(1)
    expect(listMessages(db, threadId).at(-1)!.content).toBe('budget spent')
  })
})

describe('what the model is told', () => {
  it('appends the current time to the latest user message without storing it', async () => {
    const { db, threadId, events } = setup()
    const { llm, calls } = scriptedLLM([textTurn()])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      now: () => new Date('2026-09-27T14:40:00Z'), timeZone: 'Asia/Shanghai',
    }, 'remind me in two hours', events)
    const sent = calls[0]!.messages.at(-1)!
    expect(sent.role).toBe('user')
    expect(sent.content).toContain('remind me in two hours')
    expect(sent.content).toContain('Sunday 2026-09-27 22:40')
    expect(listMessages(db, threadId)[0]!.content).toBe('remind me in two hours')
  })

  it('carries the operating manual and the bot\'s routines into the system prompt', async () => {
    const { db, threadId, events } = setup()
    const { llm, calls } = scriptedLLM([textTurn()])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      manual: '- Draft only. Never send.',
      routines: [{ id: 7, name: 'Morning digest', human: 'every day at 09:00', enabled: true }],
    }, 'hi', events)
    const system = calls[0]!.messages[0]!.content ?? ''
    expect(system).toContain('Draft only. Never send.')
    expect(system).toContain('#7 Morning digest')
  })
})

describe('vision', () => {
  it('shows the model its own screenshot when vision is on, keeping only the latest one', async () => {
    const { db, threadId, events } = setup()
    const computer = createFakeComputer()
    const { llm, calls } = scriptedLLM([
      toolTurn('browser_screenshot', {}, 's1'),
      toolTurn('browser_screenshot', {}, 's2'),
      textTurn(),
    ])
    await runTurn({
      db, llm, bot, soul: '', threadId, vision: true,
      getComputer: async () => computer,
      saveShot: async () => ({ url: '/api/screenshots/researcher/1.png', width: 1, height: 1 }),
    }, 'look', events)
    const withImages = (n: number) => calls[n]!.messages.filter((m) => m.images?.length)
    expect(withImages(1)).toHaveLength(1)
    expect(withImages(1)[0]!.images![0]).toMatch(/^data:image\/png;base64,/)
    expect(withImages(2)).toHaveLength(1) // 第一张已被替换成文字占位
  })

  it('keeps screenshots out of the model context when vision is off', async () => {
    const { db, threadId, events } = setup()
    const computer = createFakeComputer()
    const { llm, calls } = scriptedLLM([toolTurn('browser_screenshot', {}), textTurn()])
    await runTurn({
      db, llm, bot, soul: '', threadId,
      getComputer: async () => computer,
      saveShot: async () => ({ url: '/x.png', width: 1, height: 1 }),
    }, 'look', events)
    expect(calls[1]!.messages.some((m) => m.images?.length)).toBe(false)
  })
})

describe('history hygiene', () => {
  it('never sends an empty user message (an operator decision becomes a readable line)', async () => {
    const { db, threadId, events } = setup()
    insertMessage(db, {
      threadId, sender: 'user', kind: 'approval_resolved',
      payload: { approvalId: 1, action: 'send the brief', decision: 'approve' },
    })
    const { llm, calls } = scriptedLLM([textTurn()])
    await runTurn({ db, llm, bot, soul: '', threadId }, 'next?', events)
    const users = calls[0]!.messages.filter((m) => m.role === 'user')
    expect(users.every((m) => (m.content ?? '').trim().length > 0)).toBe(true)
    expect(users.some((m) => (m.content ?? '').includes('[operator decision]'))).toBe(true)
  })
})

describe('stopping a long command', () => {
  it('interrupts a running shell call instead of waiting it out', async () => {
    const { db, threadId, events } = setup()
    const stop = new AbortController()
    let sawSignal = false
    const computer = createFakeComputer({
      shell: (_cmd, _timeout, signal) => new Promise((_resolve, reject) => {
        sawSignal = Boolean(signal)
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    })
    const { llm } = scriptedLLM([toolTurn('shell', { cmd: 'npm run dev', timeoutMs: 0 }), textTurn()])
    const turn = runTurn({ db, llm, bot, soul: '', threadId, signal: stop.signal, getComputer: async () => computer }, 'go', events)
    await new Promise((r) => setTimeout(r, 20))
    stop.abort()
    await turn
    expect(sawSignal).toBe(true)
    expect(listMessages(db, threadId).at(-1)!.content).toMatch(/^⏹/)
  })

  it('caps the timeout a model asks for', async () => {
    const seen: (number | undefined)[] = []
    for (const timeoutMs of [0, 99_999_999, 5_000]) {
      const { db, threadId, events } = setup()
      const computer = createFakeComputer({ shell: async (_cmd, t) => { seen.push(t); return { stdout: '', stderr: '', exitCode: 0 } } })
      const { llm } = scriptedLLM([toolTurn('shell', { cmd: 'sleep 1', timeoutMs }), textTurn()])
      await runTurn({ db, llm, bot, soul: '', threadId, getComputer: async () => computer }, 'go', events)
    }
    expect(seen).toEqual([60_000, 600_000, 5_000])
  })
})

describe('per-turn limits', () => {
  const shellTurn = (i: number) => toolTurn('shell', { cmd: `step ${i}` }, `c${i}`)
  const computer = () => createFakeComputer()

  it('defaults to a step cap roomy enough for real browser work', () => {
    expect(DEFAULT_MAX_STEPS).toBe(40)
  })

  it('at the step cap, asks the model once more for a text-only wrap-up and posts it', async () => {
    const { db, threadId, events } = setup()
    const script = [shellTurn(1), shellTurn(2), shellTurn(3), textTurn('Ran two of three checks; the third needs your login.')]
    const { llm, calls } = scriptedLLM(script)
    await runTurn({ db, llm, bot, soul: '', threadId, maxSteps: 3, getComputer: async () => computer() }, 'go', events)
    expect(calls).toHaveLength(4)
    expect(calls[3]!.opts?.toolChoice).toBe('none')
    expect(calls[3]!.messages.at(-1)!.content).toMatch(/3-step limit.*Do not call any tools/s)
    const last = listMessages(db, threadId).at(-1)!.content
    expect(last).toMatch(/^Ran two of three checks/)
    expect(last).toMatch(/Paused at the 3-step limit for one turn\. Say "continue"/)
  })

  it('still says why it paused when the wrap-up call fails', async () => {
    const { db, threadId, events } = setup()
    const { llm } = scriptedLLM([shellTurn(1), shellTurn(2)]) // 收尾那一次会因为脚本用完而抛错
    await runTurn({ db, llm, bot, soul: '', threadId, maxSteps: 2, getComputer: async () => computer() }, 'go', events)
    expect(listMessages(db, threadId).at(-1)!.content).toBe('⏸ Paused at the 2-step limit for one turn. Say "continue" to pick it up.')
  })

  it('does not spend the wrap-up call once the budget is gone', async () => {
    const { db, threadId, events } = setup()
    let checks = 0
    const { llm, calls } = scriptedLLM([shellTurn(1), textTurn('never')])
    await runTurn({
      db, llm, bot, soul: '', threadId, maxSteps: 1, getComputer: async () => computer(),
      checkBudget: () => (++checks > 1 ? 'budget spent' : null),
    }, 'go', events)
    expect(calls).toHaveLength(1)
    expect(listMessages(db, threadId).at(-1)!.content).toBe('budget spent')
  })

  it('pauses between steps once the turn has run past its time limit', async () => {
    const { db, threadId, events } = setup()
    const slow: LLM = {
      async chat(messages, _tools, opts) {
        await new Promise((r) => setTimeout(r, 15))
        if (opts?.toolChoice === 'none') return textTurn('Halfway through the list.')
        return toolTurn('shell', { cmd: `step ${messages.length}` })
      },
    }
    await runTurn({ db, llm: slow, bot, soul: '', threadId, turnTimeoutMs: 10, getComputer: async () => computer() }, 'go', events)
    const last = listMessages(db, threadId).at(-1)!.content
    expect(last).toMatch(/^Halfway through the list\./)
    expect(last).toMatch(/1-second limit for one turn/)
  })

  it('treats a time limit of 0 as no limit', async () => {
    const { db, threadId, events } = setup()
    const { llm, calls } = scriptedLLM([shellTurn(1), textTurn('Done.')])
    await runTurn({ db, llm, bot, soul: '', threadId, turnTimeoutMs: 0, getComputer: async () => computer() }, 'go', events)
    expect(calls).toHaveLength(2)
    expect(listMessages(db, threadId).at(-1)!.content).toBe('Done.')
  })
})
