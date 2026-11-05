import { execFileSync } from 'node:child_process'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApproval, getApproval } from '../src/approvals.js'
import { loadOrCreateToken, restrictToOwner } from '../src/auth.js'
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
    // 0600 是 POSIX 的权限位；Windows 上看 ACL（见下面的 restrictToOwner）
    if (process.platform !== 'win32') expect(statSync(join(dir, 'auth-token')).mode & 0o777).toBe(0o600)
  })

  it('lets an explicit token win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogb-auth-'))
    expect(loadOrCreateToken(dir, 'from-env-token')).toBe('from-env-token')
  })
})

describe('restrictToOwner', () => {
  it('on Windows, clears direct entries, drops inherited access and grants only the current user, by SID', () => {
    const calls: { file: string; args: string[] }[] = []
    const run = (file: string, args: string[]) => {
      calls.push({ file, args })
      return file === 'whoami' ? '"pc\\ana","S-1-5-21-111-222-333-1001"\r\n' : 'processed file: C:\\data\\auth-token'
    }
    restrictToOwner('C:\\data\\auth-token', 'win32', run)
    expect(calls).toEqual([
      { file: 'whoami', args: ['/user', '/fo', 'csv', '/nh'] },
      { file: 'icacls', args: ['C:\\data\\auth-token', '/reset'] },
      { file: 'icacls', args: ['C:\\data\\auth-token', '/inheritance:r', '/grant:r', '*S-1-5-21-111-222-333-1001:F'] },
    ])
  })

  it('refuses to guess when whoami reports no SID', () => {
    expect(() => restrictToOwner('C:\\x', 'win32', () => 'nothing useful')).toThrow(/SID/)
  })

  it('warns instead of failing start-up when the file cannot be restricted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogb-token-'))
    const warnings: string[] = []
    const token = loadOrCreateToken(dir, undefined, { restrict: () => { throw new Error('icacls missing') }, warn: (l) => warnings.push(l) })
    expect(token).toMatch(/^[\w-]{20,}$/)
    expect(warnings.join('\n')).toMatch(/could not limit .*auth-token to your account: icacls missing/)
  })

  it.skipIf(process.platform !== 'win32')('really leaves only the current user on the file (Windows)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ogb-acl-')), 'auth-token')
    writeFileSync(file, 'secret\n')
    // 先塞一条直接写在文件上的「Users 可读」：继承开关管不到它，得靠 /reset 清掉
    execFileSync('icacls', [file, '/grant', '*S-1-5-32-545:R'], { encoding: 'utf8' })
    restrictToOwner(file)
    const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim().match(/"(S-1-[\d-]+)"\s*$/)![1]!
    const listing = execFileSync('icacls', [file], { encoding: 'utf8' })
    const entries = listing.split(/\r?\n/).slice(0, -1).map((l) => l.replace(file, '').trim()).filter((l) => l.includes(':('))
    expect(entries, listing).toHaveLength(1)
    expect(entries[0], listing).not.toMatch(/\(I\)/) // 不再有继承来的条目
    expect(listing).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/)
    expect(sid).toMatch(/^S-1-/)
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

  it('only takes JSON for state changes, which no other page can send without a preflight', async () => {
    const { app } = setup()
    const res = await app.request('http://localhost:4747/api/threads/dm:researcher/messages', {
      method: 'POST',
      headers: { ...cookie, 'Content-Type': 'text/plain', Origin: 'http://localhost:4747' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(415)
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

describe('websocket upgrades', () => {
  it('takes its own address from the Host header, even when the request URL has no port', async () => {
    const { app } = setup()
    // 以前的 @hono/node-ws 把升级请求的 URL 拼成 http://localhost/ws，端口丢了；node-server 2 改用 Host 头来拼。
    // 网关只认 Host 头，哪个适配器再丢端口，来源检查也不会把自己当成跨站
    const res = await app.request('http://localhost/ws', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', ...cookie, Host: 'localhost:4747', Origin: 'http://localhost:4747' },
    })
    expect(res.status).not.toBe(403)
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

describe('isProtectedPath', () => {
  it('guards the data, the live stream and both kinds of screen; leaves the page and the sign-in link open', async () => {
    const { isProtectedPath } = await import('../src/auth.js')
    for (const p of ['/api/bots', '/ws', '/vnc/researcher/view.html', '/vnc/researcher/websockify', '/screen/researcher/ws']) {
      expect(isProtectedPath(p), p).toBe(true)
    }
    for (const p of ['/', '/index.html', '/assets/app.js', '/auth', '/hooks/routines/1']) expect(isProtectedPath(p), p).toBe(false)
  })
})
