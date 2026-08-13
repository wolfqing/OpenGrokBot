import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensureDmThread, listMessages, openDb, upsertBot } from '../src/db.js'
import { createHub } from '../src/hub.js'
import type { AssistantTurn, LLM } from '../src/llm.js'
import { createApp } from '../src/server.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const textTurn: AssistantTurn = { content: 'On it.', toolCalls: [], raw: { role: 'assistant', content: 'On it.' } }
const okLLM: LLM = { chat: async () => textTurn }

function setup(llm: LLM = okLLM) {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  ensureDmThread(db, bot.id)
  return { db, ...createApp({ db, llm }) }
}

describe('hub', () => {
  it('broadcasts to all clients and drops broken ones', () => {
    const hub = createHub()
    const got: string[] = []
    const good = { send: (d: string) => got.push(d) }
    const bad = { send: () => { throw new Error('gone') } }
    hub.add(good)
    hub.add(bad)
    hub.broadcast({ type: 'status', botId: 'researcher', state: 'thinking' })
    expect(got).toHaveLength(1)
    expect(JSON.parse(got[0]!)).toEqual({ type: 'status', botId: 'researcher', state: 'thinking' })
    expect(hub.size()).toBe(1)
  })
})

describe('REST', () => {
  it('GET /api/bots returns sidebar rows', async () => {
    const { app } = setup()
    const res = await app.request('/api/bots')
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows[0]).toMatchObject({ id: 'researcher', name: 'Scout', thread_id: 'dm:researcher' })
  })

  it('GET messages returns history', async () => {
    const { app } = setup()
    const res = await app.request('/api/threads/dm:researcher/messages')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST message 202s and eventually persists bot reply + broadcasts', async () => {
    const { app, db, hub } = setup()
    const got: string[] = []
    hub.add({ send: (d: string) => got.push(d) })
    const res = await app.request('/api/threads/dm:researcher/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' }),
    })
    expect(res.status).toBe(202)
    await vi.waitFor(() => {
      expect(listMessages(db, 'dm:researcher').map((m) => m.sender)).toEqual(['user', 'researcher'])
    })
    const types = got.map((d) => JSON.parse(d).type)
    expect(types).toContain('message')
    expect(types).toContain('status')
  })

  it('rejects empty text and unknown thread', async () => {
    const { app } = setup()
    const empty = await app.request('/api/threads/dm:researcher/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '  ' }),
    })
    expect(empty.status).toBe(400)
    const unknown = await app.request('/api/threads/dm:nobody/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    })
    expect(unknown.status).toBe(404)
  })
})

describe('screenshot serving', () => {
  function setupWithData() {
    const dataDir = mkdtempSync(join(tmpdir(), 'ogb-srv-'))
    const dir = join(dataDir, 'workspaces', 'researcher', 'screenshots')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '42.png'), 'PNGDATA')
    const db = openDb(':memory:')
    upsertBot(db, bot)
    ensureDmThread(db, bot.id)
    return { dataDir, ...createApp({ db, llm: okLLM, dataDir }) }
  }

  it('serves a stored screenshot as png', async () => {
    const { app } = setupWithData()
    const res = await app.request('/api/screenshots/researcher/42.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    expect(await res.text()).toBe('PNGDATA')
  })

  it('404s unknown files and rejects traversal', async () => {
    const { app } = setupWithData()
    expect((await app.request('/api/screenshots/researcher/99.png')).status).toBe(404)
    expect((await app.request('/api/screenshots/researcher/notes.md')).status).toBe(404)
    expect((await app.request('/api/screenshots/researcher/..%2F..%2Fopengrokbot.db')).status).toBe(404)
  })
})
