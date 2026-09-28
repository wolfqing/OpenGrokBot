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
  it('points the panel at the gateway\'s own viewer, with the password kept out of every request', () => {
    expect(screenPagePath('researcher', 'pw12345x')).toBe('/vnc/researcher/view.html#password=pw12345x')
    expect(screenPagePath('researcher')).toBe('/vnc/researcher/view.html')
  })
})

describe('mountScreenProxy', () => {
  function setup() {
    const app = new Hono()
    mountScreenProxy(app, { knownBot: (id) => id === 'researcher' })
    return app
  }

  it('serves a viewer page the gateway owns — nothing a bot can rewrite in its container', async () => {
    const res = await setup().request('/vnc/researcher/view.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain("from './core/rfb.js'")
    expect(html).toContain('websockify')
  })

  it('serves the noVNC library from the installed package', async () => {
    const res = await setup().request('/vnc/researcher/core/rfb.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toContain('class RFB')
    expect((await setup().request('/vnc/researcher/vendor/pako/lib/zlib/inflate.js')).status).toBe(200)
  })

  it('serves nothing else: no container files, no traversal, no unknown bots', async () => {
    const app = setup()
    expect((await app.request('/vnc/researcher/vnc.html')).status).toBe(404)
    expect((await app.request('/vnc/researcher/app/ui.js')).status).toBe(404)
    expect((await app.request('/vnc/researcher/core/..%2F..%2F..%2Fpackage.json')).status).toBe(404)
    expect((await app.request('/vnc/researcher/core/%2E%2E/package.json')).status).toBe(404)
    expect((await app.request('/vnc/nobody/view.html')).status).toBe(404)
  })

  it('leaves websocket upgrades to the websocket route', async () => {
    const app = setup()
    app.get('/vnc/:botId/websockify', (c) => c.text('ws route'))
    const res = await app.request('/vnc/researcher/websockify', { headers: { Upgrade: 'websocket' } })
    expect(await res.text()).toBe('ws route')
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
