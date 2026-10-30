import { describe, expect, it } from 'vitest'
import { runTurn, type AgentEvents } from '../src/agent.js'
import { createFakeComputer } from '../src/computer.js'
import { ensureDmThread, listMessages, openDb, upsertBot, type MessageRow } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { buildTools } from '../src/tools.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }

function scriptedLLM(script: AssistantTurn[]) {
  const calls: ChatMsg[][] = []
  const llm: LLM = {
    async chat(messages) {
      calls.push(messages.map((m) => ({ ...m })))
      const next = script.shift()
      if (!next) throw new Error('script exhausted')
      return next
    },
  }
  return { llm, calls }
}
const toolTurn = (name: string, args: unknown, id = 'c1'): AssistantTurn =>
  ({ content: null, toolCalls: [{ id, name, args }], raw: { role: 'assistant', content: null, tool_calls: [] } })
const textTurn: AssistantTurn = { content: 'Done.', toolCalls: [], raw: { role: 'assistant', content: 'Done.' } }

function setup() {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  const threadId = ensureDmThread(db, bot.id)
  const events_: MessageRow[] = []
  const events: AgentEvents = { onMessage: (m) => events_.push(m), onStatus: () => {} }
  return { db, threadId, emitted: events_, events }
}

async function runTool(name: string, args: unknown, computer = createFakeComputer(), extra = {}) {
  const { db, threadId, events, emitted } = setup()
  const { llm, calls } = scriptedLLM([toolTurn(name, args), textTurn])
  await runTurn({ db, llm, bot, soul: '', threadId, getComputer: async () => computer, ...extra }, 'go', events)
  const toolMsg = calls[1]!.find((m) => m.role === 'tool')!
  return { result: String(toolMsg.content), computer, db, threadId, emitted, calls }
}

describe('tool surface', () => {
  it('lets a bot with a computer type, press keys, scroll and go back', () => {
    const names = buildTools({ hasComputer: true }).map((t) => t.function.name)
    for (const name of ['browser_type', 'browser_press', 'browser_scroll', 'browser_back']) expect(names).toContain(name)
  })

  it('always lets a bot stop one of its routines', () => {
    expect(buildTools({ hasComputer: false }).map((t) => t.function.name)).toContain('stop_routine')
  })
})

describe('reading long pages and files', () => {
  const long = Array.from({ length: 1000 }, (_, i) => `line ${String(i).padStart(4, '0')}`).join('\n') // ~10k 字

  it('pages through a long page instead of silently cutting it at 4000 characters', async () => {
    const computer = createFakeComputer({ pageText: long })
    const first = await runTool('browser_extract', {}, computer)
    expect(first.result).toContain('line 0000')
    expect(first.result).toMatch(/offset=4000/)
    const later = await runTool('browser_extract', { offset: 8000 }, computer)
    expect(later.result).toContain('line 0999')
    expect(later.result).toMatch(/end of page/i)
  })

  it('honors a larger maxChars up to the cap', async () => {
    const computer = createFakeComputer({ pageText: long })
    const { result } = await runTool('browser_extract', { maxChars: 9000 }, computer)
    expect(result).toContain('line 0800')
  })

  it('lists the links on the page so the bot can follow them', async () => {
    const computer = createFakeComputer({ pageLinks: [{ text: 'Pricing', href: 'https://example.com/pricing' }] })
    const { result } = await runTool('browser_extract', {}, computer)
    expect(result).toContain('Pricing → https://example.com/pricing')
  })

  it('reads a file in slices too', async () => {
    const computer = createFakeComputer({ readFile: async () => long })
    const { result } = await runTool('read_file', { path: 'notes.md', offset: 4000, maxChars: 2000 }, computer)
    expect(result).not.toContain('line 0000')
    expect(result).toMatch(/offset=6000/)
  })

  it('keeps both ends of a long shell output, where errors usually are', async () => {
    const computer = createFakeComputer({ shell: async () => ({ stdout: `START\n${long}\nTHE-END`, stderr: '', exitCode: 1 }) })
    const { result } = await runTool('shell', { cmd: 'make' }, computer)
    expect(result).toContain('START')
    expect(result).toContain('THE-END')
    expect(result).toMatch(/characters omitted/)
  })
})

describe('driving the browser', () => {
  it('types into a field and can submit', async () => {
    const { result, computer } = await runTool('browser_type', { target: 'Search', text: 'grok bot', submit: true })
    expect(computer.calls).toContain('type:Search')
    expect(result).toMatch(/typed/i)
  })

  it('presses keys, scrolls and goes back', async () => {
    expect((await runTool('browser_press', { key: 'Escape' })).computer.calls).toContain('press:Escape')
    expect((await runTool('browser_scroll', { direction: 'down' })).computer.calls).toContain('scroll:down')
    expect((await runTool('browser_back', {})).computer.calls).toContain('back')
  })
})

describe('stop_routine', () => {
  it('stops one of the bot\'s own routines', async () => {
    const stopped: number[] = []
    const { result } = await runTool('stop_routine', { id: 4 }, createFakeComputer(), {
      onStopRoutine: async (id: number) => { stopped.push(id); return { ok: true, name: 'Morning digest' } },
    })
    expect(stopped).toEqual([4])
    expect(result).toMatch(/Morning digest/)
  })

  it('needs a numeric id', async () => {
    const { result } = await runTool('stop_routine', { id: 'soon' }, createFakeComputer(), {
      onStopRoutine: async () => ({ ok: true }),
    })
    expect(result).toMatch(/needs.*id/i)
  })
})

describe('activity chip', () => {
  it('shows computer steps live in one chip that updates in place', async () => {
    const { db, threadId, events, emitted } = setup()
    const computer = createFakeComputer()
    const { llm } = scriptedLLM([
      toolTurn('browser_goto', { url: 'https://example.com' }, 'a'),
      toolTurn('shell', { cmd: 'ls -la' }, 'b'),
      textTurn,
    ])
    await runTurn({ db, llm, bot, soul: '', threadId, getComputer: async () => computer }, 'go', events)
    const chips = emitted.filter((m) => m.kind === 'activity')
    expect(new Set(chips.map((m) => m.id)).size).toBe(1) // 同一张卡片反复更新
    const stored = listMessages(db, threadId).filter((m) => m.kind === 'activity')
    expect(stored).toHaveLength(1)
    const payload = stored[0]!.payload as { steps: { tool: string; summary: string; ok: boolean }[]; done: boolean }
    expect(payload.done).toBe(true)
    expect(payload.steps.map((s) => [s.tool, s.summary, s.ok])).toEqual([
      ['browser_goto', 'https://example.com', true],
      ['shell', 'ls -la', true],
    ])
  })

  it('marks a failed step', async () => {
    const { db, threadId, events } = setup()
    const computer = createFakeComputer({ goto: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED') } })
    const { llm } = scriptedLLM([toolTurn('browser_goto', { url: 'https://nope.invalid' }), textTurn])
    await runTurn({ db, llm, bot, soul: '', threadId, getComputer: async () => computer }, 'go', events)
    const chip = listMessages(db, threadId).find((m) => m.kind === 'activity')!
    expect((chip.payload as { steps: { ok: boolean }[] }).steps[0]!.ok).toBe(false)
  })

  it('stays out of turns that never touch the computer', async () => {
    const { db, threadId, events } = setup()
    const { llm } = scriptedLLM([
      toolTurn('message_user', { kind: 'report', payload: { lines: [{ system: 'Web', result: 'ok' }] } }),
      textTurn,
    ])
    await runTurn({ db, llm, bot, soul: '', threadId }, 'go', events)
    expect(listMessages(db, threadId).some((m) => m.kind === 'activity')).toBe(false)
  })

  it('lets the bot remember what it did in earlier turns', async () => {
    const { db, threadId, events } = setup()
    const computer = createFakeComputer()
    const first = scriptedLLM([toolTurn('shell', { cmd: 'ls reports/' }), textTurn])
    await runTurn({ db, llm: first.llm, bot, soul: '', threadId, getComputer: async () => computer }, 'go', events)
    const second = scriptedLLM([textTurn])
    await runTurn({ db, llm: second.llm, bot, soul: '', threadId, getComputer: async () => computer }, 'what did you run?', events)
    const history = second.calls[0]!.map((m) => m.content ?? '').join('\n')
    expect(history).toContain('shell: ls reports/')
  })
})

describe('action log hygiene', () => {
  const logged = async (name: string, args: unknown) => {
    const { db, threadId, events } = setup()
    const seen: string[] = []
    const { llm } = scriptedLLM([toolTurn(name, args), textTurn])
    await runTurn({
      db, llm, bot, soul: '', threadId, getComputer: async () => createFakeComputer(),
      onAction: (a) => { seen.push(a.summary) },
    }, 'go', events)
    return seen[0] ?? ''
  }

  it('keeps query strings and fragments out of logged page addresses', async () => {
    const summary = await logged('browser_goto', { url: 'https://app.example.com/reset?token=s3cr3t&x=1#frag' })
    expect(summary).toBe('https://app.example.com/reset?…')
  })

  it('masks tokens, passwords and bearer headers in logged commands', async () => {
    const summary = await logged('shell', { cmd: 'curl -H "Authorization: Bearer abc.def.ghi" https://x.test -u bob:hunter2 --token=zzz' })
    expect(summary).not.toContain('abc.def.ghi')
    expect(summary).not.toContain('hunter2')
    expect(summary).not.toContain('zzz')
    expect(summary).toContain('curl')
  })
})
