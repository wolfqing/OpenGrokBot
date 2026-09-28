import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApproval, getApproval } from '../src/approvals.js'
import { loadOrCreateToken } from '../src/auth.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { AssistantTurn, LLM } from '../src/llm.js'
import { createApp } from '../src/server.js'

const TOKEN = 'test-token-0123456789abcdef'
const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const textTurn: AssistantTurn = { content: 'ok', toolCalls: [], raw: { role: 'assistant', content: 'ok' } }
const okLLM: LLM = { chat: async () => textTurn }

function setup() {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  ensureDmThread(db, bot.id)
  return { db, ...createApp({ db, llm: okLLM, token: TOKEN }) }
}

const cookie = { Cookie: `ogb_session=${TOKEN}` }

describe('loadOrCreateToken', () => {
  it('creates a private token file once and reuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogb-auth-'))
    const first = loadOrCreateToken(dir)
    expect(first).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(loadOrCreateToken(dir)).toBe(first)
    expect(statSync(join(dir, 'auth-token')).mode & 0o777).toBe(0o600)
  })

  it('lets an explicit token win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogb-auth-'))
    expect(loadOrCreateToken(dir, 'from-env-token')).toBe('from-env-token')
  })
})

describe('gateway auth', () => {
  it('rejects API calls without credentials', async () => {
    const { app } = setup()
    expect((await app.request('/api/bots')).status).toBe(401)
    expect((await app.request('/api/bots', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
  })

  it('accepts a bearer token or the session cookie', async () => {
    const { app } = setup()
    expect((await app.request('/api/bots', { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
    expect((await app.request('/api/bots', { headers: cookie })).status).toBe(200)
    expect((await app.request('/api/session', { headers: cookie })).status).toBe(200)
  })

  it('blocks the cross-site text/plain approval that used to go through', async () => {
    const { app, db } = setup()
    const approval = createApproval(db, { threadId: 'dm:researcher', botId: bot.id, action: 'wire $5,000' })
    const res = await app.request(`/api/approvals/${approval.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(res.status).toBe(401)
    expect(getApproval(db, approval.id)!.status).toBe('pending')
  })

  it('refuses state changes from another origin even with a valid cookie', async () => {
    const { app } = setup()
    const res = await app.request('/api/threads/dm:researcher/messages', {
      method: 'POST',
      headers: { ...cookie, 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(403)
  })

  it('allows state changes from its own origin', async () => {
    const { app } = setup()
    const res = await app.request('http://localhost:4747/api/threads/dm:researcher/messages', {
      method: 'POST',
      headers: { ...cookie, 'Content-Type': 'application/json', Origin: 'http://localhost:4747' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(202)
  })

  it('guards the websocket upgrade too', async () => {
    const { app } = setup()
    const upgrade = { Upgrade: 'websocket', Connection: 'Upgrade' }
    expect((await app.request('/ws', { headers: upgrade })).status).toBe(401)
    expect((await app.request('/ws', { headers: { ...upgrade, ...cookie, Origin: 'https://evil.example' } })).status).toBe(403)
  })

  it('signs a browser in from the startup link and sets a strict cookie', async () => {
    const { app } = setup()
    const res = await app.request(`/auth?token=${TOKEN}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`ogb_session=${TOKEN}`)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Strict/i)
    expect((await app.request('/auth?token=wrong')).status).toBe(401)
  })

  it('treats localhost and 127.0.0.1 on the same port as one origin', async () => {
    const { app } = setup()
    const res = await app.request('http://127.0.0.1:4747/api/threads/dm:researcher/messages', {
      method: 'POST',
      headers: { ...cookie, 'Content-Type': 'application/json', Origin: 'http://localhost:4747' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(202)
  })
})

describe('trusted UI origins', () => {
  it('lists the web UI address so a dev proxy that rewrites Host still works', async () => {
    const { trustedOrigins } = await import('../src/auth.js')
    expect(trustedOrigins({ webUrl: 'http://localhost:5173/', allowedOrigins: ['https://bots.example.com'] }))
      .toEqual(['https://bots.example.com', 'http://localhost:5173'])
    expect(trustedOrigins({ webUrl: '', allowedOrigins: [] })).toEqual([])
  })
})
