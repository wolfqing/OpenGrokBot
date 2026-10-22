import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { listActions } from '../src/actions.js'
import { runTurn } from '../src/agent.js'
import { createRule, getApproval } from '../src/approvals.js'
import { createFakeComputer } from '../src/computer.js'
import {
  ensureDmThread, ensureGroupThread, getMessage, listMessages, openDb, upsertBot, type BotRow, type Db, type MessageRow,
} from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM, ToolDef } from '../src/llm.js'
import { createRoutine } from '../src/routines.js'
import { createApp } from '../src/server.js'
import { skillsDir } from '../src/skills.js'

const scout: BotRow = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const chief: BotRow = { id: 'chief', name: 'Chief', role: 'staff', emoji: '🎖️', soul_path: '' }
const DM = 'dm:researcher'

type App = { request: (path: string, init?: RequestInit) => Promise<Response> | Response }
const send = (app: App, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
const text = (content: string): AssistantTurn => ({ content, toolCalls: [], raw: { role: 'assistant', content } })
const tool = (name: string, args: unknown): AssistantTurn =>
  ({ content: null, toolCalls: [{ id: 't1', name, args }], raw: { role: 'assistant', content: null, tool_calls: [] } })
const last = (messages: ChatMsg[]) => messages[messages.length - 1]!
const said = (messages: ChatMsg[]) => String(last(messages).content ?? '')
const names = (tools: ToolDef[] | undefined) => (tools ?? []).map((t) => t.function.name)

function setup(reply: (messages: ChatMsg[]) => AssistantTurn, extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const db = openDb(':memory:')
  for (const b of [scout, chief]) { upsertBot(db, b); ensureDmThread(db, b.id) }
  ensureGroupThread(db, 'group:offsite-crew', 'Offsite crew', ['researcher', 'chief'])
  const dataDir = mkdtempSync(join(tmpdir(), 'ogb-v031-'))
  const seen: { messages: ChatMsg[]; tools: ToolDef[] | undefined }[] = []
  const llm: LLM = {
    async chat(messages, tools) {
      seen.push({ messages: messages.map((m) => ({ ...m })), tools })
      return reply(messages)
    },
  }
  return { db, dataDir, seen, ...createApp({ db, llm, dataDir, chiefId: 'chief', ...extra }) }
}

const chips = (db: Db, kind: string, threadId = DM): MessageRow[] => listMessages(db, threadId).filter((m) => m.kind === kind)
const lastReply = (db: Db) => listMessages(db, DM).filter((m) => m.sender !== 'user' && m.kind === 'text').at(-1)?.content

describe('watch routines', () => {
  it('runs with read-only tools and posts nothing when nothing changed', async () => {
    const { db, seen, runRoutine } = setup(() => text('Nothing new.'))
    const r = createRoutine(db, { botId: 'researcher', name: 'Status watch', cron: '*/30 * * * *', instructions: 'check the status page', mode: 'watch' })
    expect(await runRoutine(r)).toBe('ran')
    const offered = names(seen[0]!.tools)
    expect(offered).toContain('hold_for_approval')
    for (const name of ['shell', 'write_file', 'browser_click', 'browser_type', 'save_memory', 'forget_memory', 'create_routine', 'message_bot']) {
      expect(offered).not.toContain(name)
    }
    expect(said(seen[0]!.messages)).toContain('This is a watch run: look, don\'t touch.')
    expect(listMessages(db, DM)).toEqual([])
    expect(listActions(db, 'researcher')).toEqual([])
  })

  it('speaks up when something needs you', async () => {
    const { db, runRoutine } = setup(() => text('The status page shows a checkout outage since 09:12.'))
    const r = createRoutine(db, { botId: 'researcher', name: 'Status watch', cron: '*/30 * * * *', instructions: 'x', mode: 'watch' })
    await runRoutine(r)
    expect(lastReply(db)).toBe('The status page shows a checkout outage since 09:12.')
  })

  it('refuses a tool it was not given, and logs the attempt', async () => {
    const { db, seen, runRoutine } = setup((messages) =>
      last(messages).role === 'tool' ? text('Nothing new.') : tool('message_bot', { to: 'chief', content: 'do the thing' }))
    const r = createRoutine(db, { botId: 'researcher', name: 'W', cron: '*/30 * * * *', instructions: 'x', mode: 'watch' })
    await runRoutine(r)
    expect(String(seen[1]!.messages.find((m) => m.role === 'tool')!.content)).toMatch(/not available in a watch routine/)
    expect(listActions(db, 'researcher')[0]).toMatchObject({ tool: 'message_bot', ok: false, trigger: 'watch' })
    expect(listMessages(db, 'dm:chief')).toEqual([]) // 没有转交出去
  })

  it('never lets a standing rule approve what a watch run holds', async () => {
    const { db, runRoutine } = setup((messages) =>
      last(messages).role === 'tool' ? text('Held it.') : tool('hold_for_approval', { action: 'reply', kind: 'email', target: 'bob@acme.com' }))
    createRule(db, { botId: 'researcher', kind: 'email', target: 'bob@acme.com', duration: 'always', now: Date.now() })
    const r = createRoutine(db, { botId: 'researcher', name: 'W', cron: '*/30 * * * *', instructions: 'x', mode: 'watch' })
    await runRoutine(r)
    // 规则本来管得到这个去向，但这一回合是 routine 起的头：照样停下来问，chip 上说明为什么
    expect(chips(db, 'approval_request')[0]!.payload).toMatchObject({ status: 'pending', ruleHeld: 'routine' })
  })

  it('shows the mode on the routine chip and the panel', async () => {
    const { app, db } = setup((messages) =>
      last(messages).role === 'tool' ? text('Set.') : tool('create_routine', { name: 'Status watch', cron: '*/30 * * * *', mode: 'watch', instructions: 'x' }))
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'keep an eye on the status page' })
    await vi.waitFor(() => expect(lastReply(db)).toBe('Set.'))
    expect(chips(db, 'routine_created')[0]!.payload).toMatchObject({ mode: 'watch' })
    const panel = (await (await app.request('/api/bots/researcher/computer')).json()) as { routines: { mode: string }[] }
    expect(panel.routines[0]!.mode).toBe('watch')
  })
})

describe('batch holds', () => {
  const ITEMS = ['Globex · ops@globex.com', 'Initech · it@initech.com', 'Hooli · cfo@hooli.com']
  const batcher = (messages: ChatMsg[]): AssistantTurn => {
    if (last(messages).role === 'tool') return text('Holding the batch.')
    const t = said(messages)
    if (t.startsWith('Your operator approved') || t.startsWith('Your operator discarded')) return text('Done.')
    return tool('hold_for_approval', { action: 'send the renewal reminder', kind: 'email', items: [...ITEMS, ITEMS[0], ' '] })
  }
  const held = async (app: App, db: Db) => {
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'remind all of them' })
    await vi.waitFor(() => expect(lastReply(db)).toBe('Holding the batch.'))
    return chips(db, 'approval_request')[0]!
  }

  it('posts one chip for the whole batch, deduplicated, that can never become a rule', async () => {
    const { app, db } = setup(batcher)
    const chip = await held(app, db)
    expect(chip.payload).toMatchObject({
      items: ITEMS, canRemember: false, status: 'pending', rememberBlocked: 'a batch always asks, item by item',
    })
  })

  it('approves only the items you kept and tells the bot exactly which', async () => {
    const { app, db, seen } = setup(batcher)
    const chip = await held(app, db)
    const id = (chip.payload as { approvalId: number }).approvalId
    expect((await send(app, 'POST', `/api/approvals/${id}`, { decision: 'approve', items: [2, 0] })).status).toBe(202)
    await vi.waitFor(() => expect(lastReply(db)).toBe('Done.'))
    expect(getMessage(db, chip.id)!.payload).toMatchObject({ status: 'approved', approvedItems: [0, 2] })
    expect(chips(db, 'approval_resolved')[0]!.payload).toMatchObject({ count: { approved: 2, of: 3 } })
    const seed = said(seen.at(-1)!.messages)
    expect(seed).toContain('for exactly these 2 of 3 items:\n1. Globex · ops@globex.com\n2. Hooli · cfo@hooli.com')
    expect(seed).toContain('They left these out; do not touch them:\n- Initech · it@initech.com')
    expect(seed).toContain('Never add an item.')
    // 模型看到的审批记录被裁过，但它列的条目和你放行的那几项必须还在
    const history = seen.at(-1)!.messages.map((m) => String(m.content ?? '')).join('\n')
    expect(history).toContain('"approvedItems":[0,2]')
    expect(history).toContain('"count":{"approved":2,"of":3}')
    expect(listActions(db, 'researcher').find((a) => a.tool === 'approval')!.summary)
      .toBe('approved by you: send the renewal reminder (2 of 3 items)')
  })

  it('refuses item picks that are empty, repeated, out of range, on a discard, or on a single action', async () => {
    const { app, db } = setup(batcher)
    const id = ((await held(app, db)).payload as { approvalId: number }).approvalId
    for (const items of [[], [0, 0], [3], [-1], ['0']]) {
      expect((await send(app, 'POST', `/api/approvals/${id}`, { decision: 'approve', items })).status).toBe(400)
    }
    expect((await send(app, 'POST', `/api/approvals/${id}`, { decision: 'discard', items: [0] })).status).toBe(400)
    expect((await send(app, 'POST', `/api/approvals/${id}`, { decision: 'approve', items: [0], remember: '1h' })).status).toBe(400)
    expect(getApproval(db, id)!.status).toBe('pending')
  })

  it('takes a bare 👍 as approving the whole batch', async () => {
    const { app, db } = setup(batcher)
    const chip = await held(app, db)
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: '👍' })
    await vi.waitFor(() => expect(lastReply(db)).toBe('Done.'))
    expect(getMessage(db, chip.id)!.payload).toMatchObject({ approvedItems: [0, 1, 2] })
  })
})

describe('shared skills', () => {
  function withSkills(dataDir: string) {
    mkdirSync(skillsDir(dataDir), { recursive: true })
    writeFileSync(join(skillsDir(dataDir), 'weekly-report.md'), '---\ndescription: How the Friday report is laid out\n---\nThree sections: wins, risks, asks.\n')
  }

  it('lists skills in every prompt and reads one on demand', async () => {
    const { app, db, dataDir, seen } = setup((messages) => {
      if (last(messages).role === 'tool') return text('Following it.')
      return tool('read_skill', { name: 'weekly-report' })
    })
    withSkills(dataDir)
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'write the weekly report' })
    await vi.waitFor(() => expect(lastReply(db)).toBe('Following it.'))
    expect(String(seen[0]!.messages[0]!.content)).toContain('- weekly-report — How the Friday report is laid out')
    expect(names(seen[0]!.tools)).toContain('read_skill')
    expect(String(seen[1]!.messages.find((m) => m.role === 'tool')!.content)).toBe('Three sections: wins, risks, asks.')
    const panel = (await (await app.request('/api/bots/researcher/computer')).json()) as { skills: unknown[] }
    expect(panel.skills).toEqual([{ name: 'weekly-report', description: 'How the Friday report is laid out' }])
  })

  it('names the real skills when asked for one that does not exist, and offers no tool when there are none', async () => {
    const { app, db, dataDir, seen } = setup((messages) =>
      last(messages).role === 'tool' ? text('Ok.') : tool('read_skill', { name: '../../auth-token' }))
    withSkills(dataDir)
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'go' })
    await vi.waitFor(() => expect(lastReply(db)).toBe('Ok.'))
    expect(String(seen[1]!.messages.find((m) => m.role === 'tool')!.content)).toBe('No skill called "../../auth-token". The shared skills are: weekly-report.')

    const bare = setup(() => text('hi'))
    await send(bare.app, 'POST', `/api/threads/${DM}/messages`, { text: 'hi' })
    await vi.waitFor(() => expect(bare.seen).toHaveLength(1))
    expect(names(bare.seen[0]!.tools)).not.toContain('read_skill')
  })
})

describe('action log', () => {
  it('records what each step did and who started it, and serves it to the panel', async () => {
    const { app, db } = setup((messages) => {
      if (last(messages).role === 'tool') return text('Saved.')
      return tool('save_memory', { rule: 'Quiet accounts wait for my read.' })
    })
    await send(app, 'POST', `/api/threads/${DM}/messages`, { text: 'from now on quiet accounts wait' })
    await vi.waitFor(() => expect(lastReply(db)).toBe('Saved.'))
    const entries = (await (await app.request('/api/bots/researcher/actions')).json()) as Record<string, unknown>[]
    expect(entries[0]).toMatchObject({ tool: 'save_memory', summary: 'Quiet accounts wait for my read.', ok: true, trigger: 'you', thread_id: DM })
    expect((await app.request('/api/bots/nobody/actions')).status).toBe(404)
    const panel = (await (await app.request('/api/bots/researcher/computer')).json()) as { actions: unknown[] }
    expect(panel.actions).toHaveLength(1)
  })

  it('records a webhook call before the routine it starts', async () => {
    const { app, db } = setup(() => text('Triaged.'))
    const r = createRoutine(db, { botId: 'researcher', name: 'Triage', cron: '', instructions: 'x', webhook: true })
    await send(app, 'POST', `/hooks/routines/${r.id}?key=${r.webhook_key}`, '{"a":1}')
    await vi.waitFor(() => expect(lastReply(db)).toBe('Triaged.'))
    expect(listActions(db, 'researcher')[0]).toMatchObject({ tool: 'webhook', trigger: 'webhook', summary: 'routine #1 "Triage" called (7 characters)' })
  })

  it('never writes what was typed into a page, only where', async () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const threadId = ensureDmThread(db, scout.id)
    const logged: { tool: string; summary: string }[] = []
    let n = 0
    const llm: LLM = { async chat() { return ++n === 1 ? tool('browser_type', { target: '#password', text: 'hunter2' }) : text('ok') } }
    await runTurn({
      db, llm, bot: scout, soul: '', threadId, getComputer: async () => createFakeComputer(),
      onAction: (a) => logged.push(a),
    }, 'sign in', { onMessage: () => {}, onStatus: () => {} })
    expect(logged).toEqual([expect.objectContaining({ tool: 'browser_type', summary: '#password', ok: true })])
    expect(JSON.stringify(logged)).not.toContain('hunter2')
  })
})
