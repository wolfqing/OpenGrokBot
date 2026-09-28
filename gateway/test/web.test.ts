import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { serveWeb } from '../src/web.js'

function setup() {
  const dist = mkdtempSync(join(tmpdir(), 'ogb-web-'))
  mkdirSync(join(dist, 'assets'))
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>OpenGrokBot</title>')
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)')
  writeFileSync(join(dist, 'favicon.svg'), '<svg/>')
  const app = new Hono()
  app.get('/api/known', (c) => c.json({ ok: true }))
  serveWeb(app, dist)
  return app
}

describe('serveWeb', () => {
  it('serves the app shell without caching it', async () => {
    const res = await setup().request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('OpenGrokBot')
  })

  it('serves hashed assets with a long cache and the right type', async () => {
    const res = await setup().request('/assets/index-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
  })

  it('serves other static files by extension', async () => {
    const res = await setup().request('/favicon.svg')
    expect(res.headers.get('content-type')).toContain('image/svg+xml')
  })

  it('falls back to the app shell for client-side routes', async () => {
    const res = await setup().request('/threads/dm:researcher')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('OpenGrokBot')
  })

  it('never serves files outside the dist folder', async () => {
    const res = await setup().request('/..%2F..%2F..%2Fetc%2Fpasswd')
    expect(await res.text()).not.toContain('root:')
  })

  it('leaves the API alone: unknown API routes still 404', async () => {
    const app = setup()
    expect((await app.request('/api/known')).status).toBe(200)
    expect((await app.request('/api/nope')).status).toBe(404)
  })

  it('does nothing when there is no built UI (dev mode uses Vite)', async () => {
    const app = new Hono()
    serveWeb(app, '/no/such/dist')
    expect((await app.request('/')).status).toBe(404)
  })
})
