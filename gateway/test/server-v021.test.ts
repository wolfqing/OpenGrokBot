import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { attachApprovalMessage, createApproval, getApproval } from '../src/approvals.js'
import { createFakeComputer } from '../src/computer.js'
import {
  ensureDmThread, ensureGroupThread, insertMessage, listMessages, openDb, recordUsage, upsertBot, type BotRow,
} from '../src/db.js'
import type { AssistantTurn, ChatMsg, ChatOptions, LLM } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createRoutine, getRoutine, type RoutineRow } from '../src/routines.js'
import type { Scheduler } from '../src/scheduler.js'
import { createApp } from '../src/server.js'

const scout: BotRow = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const ticker: BotRow = { id: 'market-watch', name: 'Ticker', role: 'markets', emoji: '📈', soul_path: '' }
const chief: BotRow = { id: 'chief', name: 'Chief', role: 'staff', emoji: '🎖️', soul_path: '' }
const GROUP = 'group:offsite-crew'
const DM = 'dm:researcher'

type App = { request: (path: string, init?: RequestInit) => Promise<Response> | Response }
const send = (app: App, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const text = (content: string, usage?: AssistantTurn['usage']): AssistantTurn =>
  ({ content, toolCalls: [], raw: { role: 'assistant', content }, ...(usage ? { usage } : {}) })
const tool = (name: string, args: unknown): AssistantTurn =>
  ({ content: null, toolCalls: [{ id: 't1', name, args }], raw: { role: 'assistant', content: null, tool_calls: [] } })
const whoAmI = (messages: ChatMsg[]) => String(messages[0]?.content ?? '').match(/You are ([\w -]+),/)?.[1] ?? '?'

/** 记录并发度、每次调用看到的消息；可以按调用挂起直到放行或被 abort。 */
function recordingLLM(reply: (messages: ChatMsg[], n: number) => AssistantTurn = () => text('ok'), delayMs = 20) {
  let active = 0
  let calls = 0
  const log = { maxActive: 0, seen: [] as { who: string; messages: ChatMsg[]; at: number; done?: number }[] }
  const llm: LLM = {
    async chat(messages, _tools, opts?: ChatOptions) {
      const entry: { who: string; messages: ChatMsg[]; at: number; done?: number } = { who: whoAmI(messages), messages, at: Date.now() }
      log.seen.push(entry)
      active++
      log.maxActive = Math.max(log.maxActive, active)
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs)
          opts?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')) })
        })
        return reply(messages, ++calls)
      } finally {
        active--
        entry.done = Date.now()
      }
    },
  }
  return { llm, log }
}

function setup(llm: LLM, extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const db = openDb(':memory:')
  for (const b of [scout, ticker, chief]) { upsertBot(db, b); ensureDmThread(db, b.id) }
  ensureGroupThread(db, GROUP, 'Offsite crew', ['researcher', 'market-watch', 'chief'])
  const dataDir = mkdtempSync(join(tmpdir(), 'ogb-v021-'))
  const created = createApp({ db, llm, dataDir, chiefId: 'chief', ...extra })
  const events: { type: string; botId?: string; state?: string; message?: { id: number; kind: string; payload: unknown } }[] = []
  created.hub.add({ send: (d: string) => events.push(JSON.parse(d)) })
  return { db, dataDir, events, ...created }
}

describe('one turn at a time per bot', () => {
  it('never lets two turns of the same bot talk to the model at once', async () => {
    const { llm, log } = recordingLLM(() => text('ok'), 80)
    const { app, db, events } = setup(llm)
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'first' })
    await new Promise((r) => setTimeout(r, 5))
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'second' })
    await vi.waitFor(() => expect(listMessages(db, DM).filter((m) => m.sender === 'researcher')).toHaveLength(2))
    expect(log.maxActive).toBe(1)
    const statuses = events.filter((e) => e.type === 'status' && e.botId === 'researcher').map((e) => e.state)
    expect(statuses).toEqual(['thinking', 'idle'])
  })

  it('shows a message the moment it is sent, even while the bot is busy', async () => {
    const { llm } = recordingLLM(() => text('ok'), 60)
    const { app, db } = setup(llm)
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'first' })
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'second' })
    expect(listMessages(db, DM).filter((m) => m.sender === 'user').map((m) => m.content)).toEqual(['first', 'second'])
  })

  it('answers messages that piled up while it was busy in a single turn', async () => {
    const { llm, log } = recordingLLM(() => text('ok'), 80)
    const { app, db } = setup(llm)
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'one' })
    await new Promise((r) => setTimeout(r, 5))
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'two' })
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'three' })
    // 先等两轮都答完（固定 sleep 在慢机器上不够用），再留一点时间确认没有多出来的第三轮
    await vi.waitFor(() => expect(listMessages(db, DM).filter((m) => m.sender === 'researcher')).toHaveLength(2))
    await new Promise((r) => setTimeout(r, 60))
    expect(log.seen).toHaveLength(2) // 「one」一轮，「two」「three」合并成一轮
    const secondTurn = log.seen[1]!.messages.map((m) => m.content ?? '').join('\n')
    expect(secondTurn).toContain('two')
    expect(secondTurn).toContain('three')
  })
})

describe('messages that arrive while the bot is busy', () => {
  it('answers a follow-up as the latest thing said, after the reply it missed', async () => {
    const { llm, log } = recordingLLM((messages) => text(`reply to ${messages.at(-1)!.content!.split('\n')[0]}`), 80)
    const { app, db } = setup(llm)
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'one' })
    await new Promise((r) => setTimeout(r, 10))
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'two' })
    await vi.waitFor(() => expect(listMessages(db, DM).filter((m) => m.sender === 'researcher')).toHaveLength(2))
    const second = log.seen[1]!.messages.map((m) => `${m.role}:${(m.content ?? '').split('\n')[0]}`)
    expect(second.indexOf('assistant:reply to one')).toBeLessThan(second.indexOf('user:two'))
    expect(second.at(-1)).toBe('user:two')
  })

  it('keeps a routine that runs first from answering a message still waiting its turn', async () => {
    const { llm, log } = recordingLLM(() => text('ok'), 80)
    const { app, db, runRoutine } = setup(llm)
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'one' })
    const routine = createRoutine(db, { botId: scout.id, name: 'Sweep', cron: '0 9 * * *', instructions: 'sweep the inbox' })
    void runRoutine(routine)
    await new Promise((r) => setTimeout(r, 5))
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'waiting question' })
    await vi.waitFor(() => expect(log.seen).toHaveLength(3))
    await vi.waitFor(() => expect(log.seen.every((s) => s.done)).toBe(true))
    const routineCall = log.seen.find((s) => (s.messages.at(-1)!.content ?? '').includes('sweep the inbox'))!
    expect(routineCall.messages.some((m) => (m.content ?? '').includes('waiting question'))).toBe(false)
  })
})

describe('stop', () => {
  it('stops what a thread is doing and says so', async () => {
    const { llm } = recordingLLM(() => text('never'), 5_000)
    const { app, db, events } = setup(llm)
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'long job' })
    await new Promise((r) => setTimeout(r, 10))
    const res = await send(app, 'POST', `/api/threads/${DM}/stop`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ stopped: 1 })
    await vi.waitFor(() => expect(listMessages(db, DM).at(-1)!.content).toMatch(/^⏹/))
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'status').at(-1)!.state).toBe('idle'))
  })

  it('stops a group round before the remaining speakers', async () => {
    const { llm, log } = recordingLLM(() => text('ok'), 5_000)
    const { app, db } = setup(llm)
    await send(app, 'POST', `/api/threads/${GROUP}/messages`, { text: 'status?' })
    await new Promise((r) => setTimeout(r, 10))
    await send(app, 'POST', `/api/threads/${GROUP}/stop`)
    await vi.waitFor(() => expect(listMessages(db, GROUP).filter((m) => m.content.startsWith('⏹')).length).toBeGreaterThan(0))
    expect(log.seen.some((s) => s.who === 'Chief')).toBe(false)
  })
})

describe('group rounds', () => {
  it('lets members answer in parallel and keeps the chief for last', async () => {
    const { llm, log } = recordingLLM((m) => text(`${whoAmI(m)} here`), 30)
    const { app, db } = setup(llm)
    await send(app, 'POST', `/api/threads/${GROUP}/messages`, { text: 'where are we?' })
    await vi.waitFor(() => expect(listMessages(db, GROUP).filter((m) => m.sender === 'chief')).toHaveLength(1))
    expect(log.maxActive).toBe(2) // Scout 与 Ticker 同时
    const chiefCall = log.seen.find((s) => s.who === 'Chief')!
    const members = log.seen.filter((s) => s.who !== 'Chief')
    expect(members.every((s) => s.done! <= chiefCall.at)).toBe(true)
    expect(chiefCall.messages.map((m) => m.content ?? '').join('\n')).toContain('Scout here')
  })

  it('runs a second question only after the first round has closed', async () => {
    const { llm } = recordingLLM((m) => text(`${whoAmI(m)} here`), 15)
    const { app, db } = setup(llm)
    await send(app, 'POST', `/api/threads/${GROUP}/messages`, { text: 'first question' })
    await send(app, 'POST', `/api/threads/${GROUP}/messages`, { text: 'second question' })
    await vi.waitFor(() => expect(listMessages(db, GROUP).filter((m) => m.sender === 'chief')).toHaveLength(2))
    const senders = listMessages(db, GROUP).filter((m) => m.sender !== 'user').map((m) => m.sender)
    expect(senders.indexOf('chief')).toBe(2) // 第一轮：两个成员 + Chief 收口，然后才轮到第二轮
  })
})

describe('hello snapshot', () => {
  it('tells a fresh client who is working right now', async () => {
    const { llm } = recordingLLM(() => text('ok'), 50)
    const { app, hello } = setup(llm)
    expect(hello()).toEqual({ type: 'hello', statuses: {} })
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'go' })
    expect(hello()).toEqual({ type: 'hello', statuses: { researcher: 'thinking' } })
  })
})

describe('routines run with the full toolset', () => {
  it('can hold for approval from inside a routine', async () => {
    const script = [tool('hold_for_approval', { action: 'send the digest', detail: '5 lines' }), text('Held.')]
    const { app: _app, db, runRoutine } = setup({ chat: async () => script.shift()! })
    const routine = createRoutine(db, { botId: scout.id, name: 'Digest', cron: '0 9 * * *', instructions: 'send the digest' })
    expect(await runRoutine(routine)).toBe('ran')
    const chip = listMessages(db, DM).find((m) => m.kind === 'approval_request')!
    const approvalId = (chip.payload as { approvalId: number }).approvalId
    expect(getApproval(db, approvalId)).toMatchObject({ status: 'pending', message_id: chip.id })
    expect(getRoutine(db, routine.id)!.last_run_at).not.toBeNull()
  })

  it('skips a firing while the previous run of the same routine is still going', async () => {
    const { llm, log } = recordingLLM(() => text('ok'), 40)
    const { db, runRoutine } = setup(llm)
    const routine = createRoutine(db, { botId: scout.id, name: 'Sweep', cron: '* * * * *', instructions: 'sweep' })
    const [first, second] = await Promise.all([runRoutine(routine), runRoutine(routine)])
    expect([first, second].sort()).toEqual(['ran', 'skipped'])
    expect(log.seen).toHaveLength(1)
  })
})

describe('routine controls', () => {
  function fakeScheduler() {
    const log: string[] = []
    const scheduler: Scheduler = {
      load: () => {}, add: (r: RoutineRow) => { log.push(`add:${r.id}`) }, remove: (id: number) => { log.push(`remove:${id}`) },
      stopAll: () => {}, size: () => 0,
    }
    return { scheduler, log }
  }

  it('pauses, resumes and deletes a routine, keeping the scheduler in step', async () => {
    const { scheduler, log } = fakeScheduler()
    const { app, db } = setup(recordingLLM().llm, { scheduler })
    const r = createRoutine(db, { botId: scout.id, name: 'Digest', cron: '0 9 * * *', instructions: 'x' })
    expect((await send(app, 'PATCH', `/api/routines/${r.id}`, { enabled: false })).status).toBe(200)
    expect(getRoutine(db, r.id)!.enabled).toBe(0)
    expect((await send(app, 'PATCH', `/api/routines/${r.id}`, { enabled: true })).status).toBe(200)
    expect(getRoutine(db, r.id)!.enabled).toBe(1)
    expect((await send(app, 'DELETE', `/api/routines/${r.id}`)).status).toBe(200)
    expect(getRoutine(db, r.id)).toBeNull()
    expect(log).toEqual([`remove:${r.id}`, `add:${r.id}`, `remove:${r.id}`])
  })

  it('runs a routine on demand', async () => {
    const { llm, log } = recordingLLM(() => text('ran it'))
    const { app, db } = setup(llm)
    const r = createRoutine(db, { botId: scout.id, name: 'Digest', cron: '0 9 * * *', instructions: 'post the digest' })
    expect((await send(app, 'POST', `/api/routines/${r.id}/run`)).status).toBe(202)
    await vi.waitFor(() => expect(log.seen).toHaveLength(1))
    expect(log.seen[0]!.messages.at(-1)!.content).toContain('post the digest')
  })

  it('404s unknown routines and rejects a bad body', async () => {
    const { app, db } = setup(recordingLLM().llm)
    expect((await send(app, 'PATCH', '/api/routines/999', { enabled: false })).status).toBe(404)
    expect((await send(app, 'DELETE', '/api/routines/999')).status).toBe(404)
    expect((await send(app, 'POST', '/api/routines/999/run')).status).toBe(404)
    const r = createRoutine(db, { botId: scout.id, name: 'Digest', cron: '0 9 * * *', instructions: 'x' })
    expect((await send(app, 'PATCH', `/api/routines/${r.id}`, { enabled: 'maybe' })).status).toBe(400)
  })

  it('lets a bot stop its own routine but not a teammate\'s', async () => {
    const { scheduler, log } = fakeScheduler()
    const script: AssistantTurn[] = []
    const { app, db } = setup({ chat: async () => script.shift() ?? text('ok') }, { scheduler })
    const own = createRoutine(db, { botId: scout.id, name: 'Mine', cron: '0 9 * * *', instructions: 'x' })
    const theirs = createRoutine(db, { botId: ticker.id, name: 'Theirs', cron: '0 9 * * *', instructions: 'x' })
    script.push(tool('stop_routine', { id: theirs.id }), tool('stop_routine', { id: own.id }), text('done'))
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'stop my routines' })
    await vi.waitFor(() => expect(listMessages(db, DM).at(-1)!.content).toBe('done'))
    expect(getRoutine(db, own.id)!.enabled).toBe(0)
    expect(getRoutine(db, theirs.id)!.enabled).toBe(1)
    expect(log).toEqual([`remove:${own.id}`])
  })
})

describe('persona, memory of routines and budget', () => {
  it('loads AGENTS.md next to SOUL.md and strips the frontmatter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogb-persona-'))
    mkdirSync(join(dir, 'researcher'))
    writeFileSync(join(dir, 'researcher', 'SOUL.md'), '---\nrole: research\nemoji: 🔎\n---\n# Scout\n\nYou are Scout.\n')
    writeFileSync(join(dir, 'researcher', 'AGENTS.md'), '## Hard boundaries\n- Never pay for anything.\n')
    const { llm, log } = recordingLLM()
    const { app, db } = setup(llm)
    upsertBot(db, { ...scout, soul_path: join(dir, 'researcher', 'SOUL.md') })
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'hi' })
    await vi.waitFor(() => expect(log.seen).toHaveLength(1))
    const system = String(log.seen[0]!.messages[0]!.content)
    expect(system).toContain('Never pay for anything.')
    expect(system).not.toContain('emoji:')
  })

  it('tells the bot which routines it has', async () => {
    const { llm, log } = recordingLLM()
    const { app, db } = setup(llm)
    const r = createRoutine(db, { botId: scout.id, name: 'Morning digest', cron: '0 9 * * *', instructions: 'x' })
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'hi' })
    await vi.waitFor(() => expect(log.seen).toHaveLength(1))
    expect(String(log.seen[0]!.messages[0]!.content)).toContain(`#${r.id} Morning digest — every day at 09:00`)
  })

  it('records usage and shows today\'s total on the computer panel', async () => {
    const { llm } = recordingLLM(() => text('ok', { prompt: 1000, completion: 50, cached: 800 }))
    const { app, db } = setup(llm, { dailyTokens: 100_000 })
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'hi' })
    await vi.waitFor(() => expect(listMessages(db, DM).filter((m) => m.sender === 'researcher')).toHaveLength(1))
    const panel = await (await app.request('/api/bots/researcher/computer')).json()
    expect(panel.usage).toEqual({ today: { prompt: 1000, completion: 50, cached: 800, total: 1050 }, budget: 100_000 })
  })

  it('stops a bot that spent its daily budget before it calls the model', async () => {
    const { llm, log } = recordingLLM()
    const { app, db } = setup(llm, { dailyTokens: 1000 })
    recordUsage(db, { botId: scout.id, threadId: DM, usage: { prompt: 990, completion: 10, cached: 0 }, at: Date.now() })
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'hi' })
    await vi.waitFor(() => expect(listMessages(db, DM).at(-1)!.content).toMatch(/token budget/))
    expect(log.seen).toHaveLength(0)
  })
})

describe('sidebar needs-you count', () => {
  it('counts pending approvals per conversation', async () => {
    const { app, db } = setup(recordingLLM().llm)
    createApproval(db, { threadId: DM, botId: scout.id, action: 'a' })
    createApproval(db, { threadId: DM, botId: scout.id, action: 'b' })
    const rows = (await (await app.request('/api/conversations')).json()) as { id: string; pending: number }[]
    expect(rows.find((r) => r.id === DM)!.pending).toBe(2)
    expect(rows.find((r) => r.id === GROUP)!.pending).toBe(0)
  })
})

describe('approval chip far back in history', () => {
  it('still flips live when the chip is older than the last 200 messages', async () => {
    const { app, db, events } = setup(recordingLLM().llm)
    const approval = createApproval(db, { threadId: DM, botId: scout.id, action: 'send it' })
    const chip = insertMessage(db, {
      threadId: DM, sender: scout.id, kind: 'approval_request',
      payload: { approvalId: approval.id, action: 'send it', detail: '', status: 'pending' },
    })
    attachApprovalMessage(db, approval.id, chip.id)
    for (let i = 0; i < 205; i++) insertMessage(db, { threadId: DM, sender: 'user', kind: 'text', content: `m${i}` })
    await send(app, 'POST', `/api/approvals/${approval.id}`, { decision: 'approve' })
    const flipped = events.find((e) => e.type === 'message' && e.message!.id === chip.id)
    expect((flipped!.message!.payload as { status: string }).status).toBe('approved')
  })
})

describe('warming the computer up', () => {
  it('starts the bot computer while the model thinks, for direct messages but not group chatter', async () => {
    const started: string[] = []
    const dataDir = mkdtempSync(join(tmpdir(), 'ogb-warm-'))
    const pool = createPool({ dataDir, makeComputer: async (id) => { started.push(id); return createFakeComputer() } })
    const { llm } = recordingLLM()
    const { app, db } = setup(llm, { pool })
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'hi' })
    await vi.waitFor(() => expect(started).toEqual(['researcher']))
    await send(app, 'POST', `/api/threads/${GROUP}/messages`, { text: 'status?' })
    await vi.waitFor(() => expect(listMessages(db, GROUP).filter((m) => m.sender === 'chief')).toHaveLength(1))
    expect(started).toEqual(['researcher'])
  })
})
