import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createFakeComputer } from '../src/computer.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { LLM } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createScreenViewers, mountScreenProxy, screenPagePath } from '../src/screen.js'
import { createApp } from '../src/server.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const okLLM: LLM = { chat: async () => ({ content: 'ok', toolCalls: [], raw: { role: 'assistant', content: 'ok' } }) }

describe('screenPagePath', () => {
  it('points the panel at a same-origin noVNC page that connects back through the gateway', () => {
    const url = new URL(screenPagePath('researcher', 'pw12345x'), 'http://localhost:4747')
    expect(url.pathname).toBe('/vnc/researcher/vnc.html')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      autoconnect: '1', resize: 'scale', reconnect: '1', path: 'vnc/researcher/websockify', password: 'pw12345x',
    })
  })
})

describe('mountScreenProxy', () => {
  function setup(opts: { screen?: boolean; failing?: boolean } = {}) {
    const seen: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response('<html>noVNC</html>', { headers: { 'content-type': 'text/html', 'set-cookie': 'x=1' } })
    }) as typeof fetch
    const computer = createFakeComputer(opts.screen === false ? {} : { screen: { base: 'http://127.0.0.1:53314', password: 'pw' } })
    const pool = createPool({
      dataDir: '/data',
      makeComputer: async () => { if (opts.failing) throw new Error('Docker is not running.'); return computer },
    })
    const app = new Hono()
    mountScreenProxy(app, { pool, knownBot: (id) => id === 'researcher', fetchImpl })
    return { app, seen }
  }

  it('serves the noVNC page and its assets from the bot computer', async () => {
    const { app, seen } = setup()
    const res = await app.request('/vnc/researcher/vnc.html?autoconnect=1')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('noVNC')
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.get('set-cookie')).toBeNull() // 容器的响应头不该原样漏给浏览器
    await app.request('/vnc/researcher/app/ui.js')
    expect(seen).toEqual(['http://127.0.0.1:53314/vnc.html?autoconnect=1', 'http://127.0.0.1:53314/app/ui.js'])
  })

  it('404s unknown bots and explains a missing screen', async () => {
    expect((await setup().app.request('/vnc/nobody/vnc.html')).status).toBe(404)
    const down = await setup({ failing: true }).app.request('/vnc/researcher/vnc.html')
    expect(down.status).toBe(503)
    expect(await down.text()).toMatch(/Docker is not running/)
    expect((await setup({ screen: false }).app.request('/vnc/researcher/vnc.html')).status).toBe(503)
  })

  it('leaves websocket upgrades to the websocket route', async () => {
    const { app, seen } = setup()
    app.get('/vnc/:botId/websockify', (c) => c.text('ws route'))
    const res = await app.request('/vnc/researcher/websockify', { headers: { Upgrade: 'websocket' } })
    expect(await res.text()).toBe('ws route')
    expect(seen).toEqual([])
  })
})

describe('screen viewers', () => {
  it('counts open screens per bot so an idle sweep leaves them alone', () => {
    const viewers = createScreenViewers()
    viewers.open('researcher')
    viewers.open('researcher')
    viewers.close('researcher')
    expect(viewers.watching('researcher')).toBe(true)
    viewers.close('researcher')
    expect(viewers.watching('researcher')).toBe(false)
  })
})

describe('GET /api/bots/:botId/computer', () => {
  it('hands the panel the same-origin screen page', async () => {
    const db = openDb(':memory:')
    upsertBot(db, bot)
    ensureDmThread(db, bot.id)
    const pool = createPool({
      dataDir: mkdtempSync(join(tmpdir(), 'ogb-screen-')),
      makeComputer: async () => createFakeComputer({ screen: { base: 'http://127.0.0.1:53314', password: 'pw' } }),
    })
    const { app } = createApp({ db, llm: okLLM, pool, dataDir: '/tmp' })
    const body = await (await app.request('/api/bots/researcher/computer')).json()
    expect(body.vncUrl).toBe(screenPagePath('researcher', 'pw'))
  })
})
