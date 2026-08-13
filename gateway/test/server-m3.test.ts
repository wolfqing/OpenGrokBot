import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { attachApprovalMessage, createApproval, getApproval } from '../src/approvals.js'
import { ensureDmThread, insertMessage, listMessages, openDb, upsertBot, type Db } from '../src/db.js'
import type { AssistantTurn, LLM } from '../src/llm.js'
import { memoryPath } from '../src/memory.js'
import { createRoutine } from '../src/routines.js'
import { createApp } from '../src/server.js'

const bot = { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' }
const THREAD = 'dm:inbox-keeper'
const textTurn: AssistantTurn = { content: 'Sent.', toolCalls: [], raw: { role: 'assistant', content: 'Sent.' } }
const okLLM: LLM = { chat: async () => textTurn }

type App = { request: (path: string, init?: RequestInit) => Promise<Response> | Response }

function setup(llm: LLM = okLLM) {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  ensureDmThread(db, bot.id)
  const dataDir = mkdtempSync(join(tmpdir(), 'ogb-m3-'))
  return { db, dataDir, ...createApp({ db, llm, dataDir }) }
}

const post = (app: App, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const pending = (db: Db, action = 'send 4 drafts') =>
  createApproval(db, { threadId: THREAD, botId: bot.id, action, detail: '' })

describe('POST /api/approvals/:id', () => {
  it('approves, records the decision and resumes the bot', async () => {
    const { app, db } = setup()
    const approval = pending(db)
    expect((await post(app, `/api/approvals/${approval.id}`, { decision: 'approve' })).status).toBe(202)
    expect(getApproval(db, approval.id)!.status).toBe('approved')
    await vi.waitFor(() => {
      const kinds = listMessages(db, THREAD).map((m) => m.kind)
      expect(kinds).toContain('approval_resolved')
      expect(kinds).toContain('text') // bot 续跑后的回复
    })
    // 放行不该在线程里留下假的用户气泡
    expect(listMessages(db, THREAD).every((m) => m.kind === 'approval_resolved' || m.sender !== 'user')).toBe(true)
  })

  it('discards and still records the decision', async () => {
    const { app, db } = setup()
    const approval = pending(db)
    expect((await post(app, `/api/approvals/${approval.id}`, { decision: 'discard' })).status).toBe(202)
    expect(getApproval(db, approval.id)!.status).toBe('discarded')
    await vi.waitFor(() => {
      expect(listMessages(db, THREAD).some((m) => m.kind === 'approval_resolved')).toBe(true)
    })
  })

  it('409s a second decision and 404s an unknown approval', async () => {
    const { app, db } = setup()
    const approval = pending(db)
    await post(app, `/api/approvals/${approval.id}`, { decision: 'approve' })
    expect((await post(app, `/api/approvals/${approval.id}`, { decision: 'discard' })).status).toBe(409)
    expect((await post(app, '/api/approvals/9999', { decision: 'approve' })).status).toBe(404)
  })

  it('rejects a bad decision', async () => {
    const { app, db } = setup()
    const approval = pending(db)
    expect((await post(app, `/api/approvals/${approval.id}`, { decision: 'maybe' })).status).toBe(400)
  })

  it('flips the original chip payload to resolved', async () => {
    const { app, db } = setup()
    const approval = pending(db, 'send it')
    const chip = insertMessage(db, {
      threadId: THREAD, sender: bot.id, kind: 'approval_request',
      payload: { approvalId: approval.id, action: 'send it', detail: '', status: 'pending' },
    })
    attachApprovalMessage(db, approval.id, chip.id)
    await post(app, `/api/approvals/${approval.id}`, { decision: 'approve' })
    const stored = listMessages(db, THREAD).find((m) => m.id === chip.id)!
    expect((stored.payload as { status: string }).status).toBe('approved')
  })
})

describe('thumbs-up shortcut', () => {
  it('a bare 👍 approves the newest pending action instead of chatting', async () => {
    const { app, db } = setup()
    const approval = pending(db)
    const res = await post(app, `/api/threads/${THREAD}/messages`, { text: '👍' })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ approved: true })
    expect(getApproval(db, approval.id)!.status).toBe('approved')
    expect(listMessages(db, THREAD).every((m) => m.content !== '👍')).toBe(true)
  })

  it('is an ordinary message when nothing is pending', async () => {
    const { app, db } = setup()
    const res = await post(app, `/api/threads/${THREAD}/messages`, { text: '👍' })
    expect(await res.json()).not.toMatchObject({ approved: true })
    await vi.waitFor(() => {
      expect(listMessages(db, THREAD).some((m) => m.sender === 'user' && m.content === '👍')).toBe(true)
    })
  })
})

describe('tool wiring through the app', () => {
  it('creates an approval row when the bot holds an action', async () => {
    const holdLLM: LLM & { step: number } = {
      step: 0,
      async chat() {
        this.step += 1
        return this.step === 1
          ? {
            content: null,
            toolCalls: [{ id: 'c1', name: 'hold_for_approval', args: { action: 'send the drafts', detail: '4 replies' } }],
            raw: { role: 'assistant', content: null, tool_calls: [] },
          }
          : { content: 'Holding.', toolCalls: [], raw: { role: 'assistant', content: 'Holding.' } }
      },
    }
    const { app, db } = setup(holdLLM)
    await post(app, `/api/threads/${THREAD}/messages`, { text: 'send the replies' })
    await vi.waitFor(() => {
      const chip = listMessages(db, THREAD).find((m) => m.kind === 'approval_request')
      expect(chip).toBeTruthy()
      expect((chip!.payload as { action: string }).action).toBe('send the drafts')
    })
  })

  it('flips the chip the bot itself posted, without anyone attaching ids by hand', async () => {
    const holdLLM: LLM & { step: number } = {
      step: 0,
      async chat() {
        this.step += 1
        return this.step === 1
          ? {
            content: null,
            toolCalls: [{ id: 'c1', name: 'hold_for_approval', args: { action: 'send the drafts', detail: '' } }],
            raw: { role: 'assistant', content: null, tool_calls: [] },
          }
          : { content: 'Holding.', toolCalls: [], raw: { role: 'assistant', content: 'Holding.' } }
      },
    }
    const { app, db } = setup(holdLLM)
    await post(app, `/api/threads/${THREAD}/messages`, { text: 'send the replies' })
    await vi.waitFor(() => {
      expect(listMessages(db, THREAD).some((m) => m.kind === 'approval_request')).toBe(true)
    })
    const chip = listMessages(db, THREAD).find((m) => m.kind === 'approval_request')!
    const approvalId = (chip.payload as { approvalId: number }).approvalId

    await post(app, `/api/approvals/${approvalId}`, { decision: 'approve' })
    const flipped = listMessages(db, THREAD).find((m) => m.id === chip.id)!
    expect((flipped.payload as { status: string }).status).toBe('approved')
  })

  it('writes a saved rule to the bot MEMORY.md', async () => {
    const memoryLLM: LLM & { step: number } = {
      step: 0,
      async chat() {
        this.step += 1
        return this.step === 1
          ? {
            content: null,
            toolCalls: [{ id: 'c1', name: 'save_memory', args: { rule: 'quiet accounts wait for my read' } }],
            raw: { role: 'assistant', content: null, tool_calls: [] },
          }
          : { content: 'Noted.', toolCalls: [], raw: { role: 'assistant', content: 'Noted.' } }
      },
    }
    const { app, db, dataDir } = setup(memoryLLM)
    await post(app, `/api/threads/${THREAD}/messages`, { text: 'from now on quiet accounts wait' })
    await vi.waitFor(() => {
      expect(listMessages(db, THREAD).some((m) => m.kind === 'memory_updated')).toBe(true)
    })
    expect(readFileSync(memoryPath(dataDir, bot.id), 'utf8')).toContain('- quiet accounts wait for my read')
  })

  it('rejects an invalid cron instead of scheduling it', async () => {
    const badCronLLM: LLM & { step: number } = {
      step: 0,
      async chat() {
        this.step += 1
        return this.step === 1
          ? {
            content: null,
            toolCalls: [{ id: 'c1', name: 'create_routine', args: { name: 'Bad', cron: 'every morning', instructions: 'x' } }],
            raw: { role: 'assistant', content: null, tool_calls: [] },
          }
          : { content: 'Could not schedule that.', toolCalls: [], raw: { role: 'assistant', content: 'Could not schedule that.' } }
      },
    }
    const { app, db } = setup(badCronLLM)
    await post(app, `/api/threads/${THREAD}/messages`, { text: 'schedule it' })
    await vi.waitFor(() => {
      expect(listMessages(db, THREAD).some((m) => m.kind === 'text' && m.sender === bot.id)).toBe(true)
    })
    expect(listMessages(db, THREAD).some((m) => m.kind === 'routine_created')).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM routines').get()).toMatchObject({ c: 0 })
  })
})

describe('GET /api/bots/:botId/routines', () => {
  it('lists what the bot has scheduled', async () => {
    const { app, db } = setup()
    createRoutine(db, { botId: bot.id, name: 'Morning digest', cron: '0 9 * * *', instructions: 'x' })
    const res = await app.request('/api/bots/inbox-keeper/routines')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject([{ name: 'Morning digest', cron: '0 9 * * *' }])
  })
})
