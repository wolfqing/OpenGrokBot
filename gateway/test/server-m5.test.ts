import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFakeComputer, type BotComputer } from '../src/computer.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { AssistantTurn, LLM } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createRoutine } from '../src/routines.js'
import { createApp } from '../src/server.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const textTurn: AssistantTurn = { content: 'ok', toolCalls: [], raw: { role: 'assistant', content: 'ok' } }
const okLLM: LLM = { chat: async () => textTurn }

type App = { request: (path: string, init?: RequestInit) => Promise<Response> | Response }
const post = (app: App, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

function setup(makeComputer?: (botId: string) => Promise<BotComputer>) {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  ensureDmThread(db, bot.id)
  const dataDir = mkdtempSync(join(tmpdir(), 'ogb-m5-'))
  const pool = makeComputer ? createPool({ dataDir, makeComputer }) : undefined
  return { db, dataDir, ...createApp({ db, llm: okLLM, dataDir, pool }) }
}

describe('GET /api/bots/:botId/computer', () => {
  it('reports the screen address and what is scheduled', async () => {
    const { app, db } = setup(async () => createFakeComputer({ screen: { base: 'http://127.0.0.1:53314', password: 'pw' } }))
    createRoutine(db, { botId: bot.id, name: 'Morning digest', cron: '0 9 * * *', instructions: 'x' })
    const res = await app.request('/api/bots/researcher/computer')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      botId: 'researcher',
      running: true,
      vncUrl: '/vnc/researcher/view.html#password=pw',
      routines: [{ name: 'Morning digest', human: 'every day at 09:00' }],
    })
  })

  it('says the computer is off rather than failing when docker is unavailable', async () => {
    const { app } = setup(async () => { throw new Error('docker daemon not running') })
    const res = await app.request('/api/bots/researcher/computer')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { running: boolean; vncUrl: null; error: string }
    expect(body).toMatchObject({ running: false, vncUrl: null })
    expect(body.error).toMatch(/docker daemon/)
  })

  it('reports no screen when no pool is configured at all', async () => {
    const { app } = setup()
    expect(await (await app.request('/api/bots/researcher/computer')).json())
      .toMatchObject({ running: false, vncUrl: null, routines: [] })
  })

  it('404s an unknown bot', async () => {
    const { app } = setup(async () => createFakeComputer())
    expect((await app.request('/api/bots/nobody/computer')).status).toBe(404)
  })
})

describe('POST /api/bots', () => {
  it('hires a teammate, writes its soul and gives it a thread', async () => {
    const { app, db, dataDir } = setup()
    const res = await post(app, '/api/bots', { name: 'Talent Scout', role: 'Finds and screens candidates' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ id: 'talent-scout', name: 'Talent Scout' })
    expect(db.prepare('SELECT id FROM threads WHERE id = ?').get('dm:talent-scout')).toBeTruthy()
    expect(existsSync(join(dataDir, 'teammates', 'talent-scout', 'SOUL.md'))).toBe(true)
  })

  it('shows up in the conversation list right away', async () => {
    const { app } = setup()
    await post(app, '/api/bots', { name: 'Talent Scout', role: 'x' })
    const rows = (await (await app.request('/api/conversations')).json()) as { id: string }[]
    expect(rows.map((r) => r.id)).toContain('dm:talent-scout')
  })

  it('rejects an empty name and a duplicate', async () => {
    const { app } = setup()
    expect((await post(app, '/api/bots', { name: '  ', role: 'x' })).status).toBe(400)
    await post(app, '/api/bots', { name: 'Ops', role: 'x' })
    const dup = await post(app, '/api/bots', { name: 'Ops', role: 'y' })
    expect(dup.status).toBe(400)
    expect(((await dup.json()) as { error: string }).error).toMatch(/already/i)
  })
})

describe('a local computer in the panel API', () => {
  const local = (shown: { value: boolean }) => createFakeComputer({
    kind: 'local',
    screencast: async () => async () => {},
    showWindow: async () => { shown.value = true },
    hideWindow: async () => { shown.value = false },
    windowShown: () => shown.value,
  })

  it('reports its kind, a screencast screen instead of a VNC page, and whether its window is up', async () => {
    const shown = { value: false }
    const { app } = setup(async () => local(shown))
    const body = await (await app.request('/api/bots/researcher/computer')).json()
    expect(body).toMatchObject({ running: true, kind: 'local', vncUrl: null, screen: { kind: 'cdp', url: '/screen/researcher/ws' }, window: false })
  })

  it('still reports a sealed computer the old way, plus its kind', async () => {
    const { app } = setup(async () => createFakeComputer({ screen: { base: 'http://127.0.0.1:1', password: 'pw' } }))
    const body = await (await app.request('/api/bots/researcher/computer')).json()
    expect(body).toMatchObject({ kind: 'docker', screen: { kind: 'vnc', url: '/vnc/researcher/view.html#password=pw' }, window: false })
  })

  it('opens and closes the sign-in window on request, and refuses it for a sealed computer', async () => {
    const shown = { value: false }
    const { app } = setup(async () => local(shown))
    expect(await (await post(app, '/api/bots/researcher/computer/window', { shown: true })).json()).toEqual({ ok: true, window: true })
    expect(shown.value).toBe(true)
    expect(await (await post(app, '/api/bots/researcher/computer/window', { shown: false })).json()).toEqual({ ok: true, window: false })
    expect((await post(app, '/api/bots/researcher/computer/window', { shown: 'yes' })).status).toBe(400)
    expect((await post(app, '/api/bots/nobody/computer/window', { shown: true })).status).toBe(404)
    const sealed = setup(async () => createFakeComputer())
    expect((await post(sealed.app, '/api/bots/researcher/computer/window', { shown: true })).status).toBe(409)
  })
})
