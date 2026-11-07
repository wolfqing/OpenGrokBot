import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import {
  MAIN, botConfig, botLlm, createConnection, deleteConnection, readConnectionKey, setBotLlm, updateConnection,
} from '../src/connections.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { AssistantTurn, LLM } from '../src/llm.js'
import { createApp } from '../src/server.js'
import { saveApiKey, saveSettings } from '../src/settings.js'

const scout = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const ticker = { id: 'market-watch', name: 'Ticker', role: 'markets', emoji: '📈', soul_path: '' }
const CLAUDE_KEY = 'sk-ant-api03-abcdefghijklmnop'

function setup(env: Record<string, string> = {}) {
  const db = openDb(':memory:')
  upsertBot(db, scout)
  upsertBot(db, ticker)
  const dataDir = mkdtempSync(join(tmpdir(), 'ogb-conn-'))
  const startup = loadConfig({ ...env, OPENGROKBOT_DATA: dataDir })
  return { db, dataDir, startup, env: { ...env, OPENGROKBOT_DATA: dataDir } }
}

describe('model connections', () => {
  it('fill in the preset (address, model, API) and keep the key in its own 0600 file', () => {
    const { db, dataDir } = setup()
    const made = createConnection(db, dataDir, { provider: 'anthropic', apiKey: CLAUDE_KEY })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(made.connection).toMatchObject({ name: 'Claude', api: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-opus-5-5', vision: true })
    expect(made.connection.id).toMatch(/^c-[0-9a-f]{8}$/)
    const file = join(dataDir, 'llm-keys', made.connection.id)
    expect(readFileSync(file, 'utf8').trim()).toBe(CLAUDE_KEY)
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(join(dataDir, 'llm-keys')).mode & 0o777).toBe(0o700)
    }
  })

  it('refuse a Claude subscription sign-in token: only API keys are allowed for third-party apps', () => {
    const { db, dataDir } = setup()
    const made = createConnection(db, dataDir, { provider: 'anthropic', apiKey: 'sk-ant-oat01-abcdefghijklmnop' })
    expect(made).toEqual({ ok: false, errors: [{ key: 'apiKey', code: 'subscription_token' }] })
  })

  it('let only a custom connection pick its API, and check every field', () => {
    const { db, dataDir } = setup()
    const custom = createConnection(db, dataDir, { provider: 'custom', api: 'anthropic', baseURL: 'https://api.minimax.io/anthropic', model: 'MiniMax-M3' })
    expect(custom.ok && custom.connection.api).toBe('anthropic')
    const preset = createConnection(db, dataDir, { provider: 'deepseek', api: 'anthropic' })
    expect(preset.ok && preset.connection.api).toBe('chat')
    const broken = createConnection(db, dataDir, { provider: 'nope', baseURL: 'ftp://x', model: '', vision: 'yes' })
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.errors.map((e) => e.key).sort()).toEqual(['baseURL', 'model', 'provider', 'vision'])
    expect(createConnection(db, dataDir, { provider: 'custom' })).toMatchObject({ ok: false })
  })

  it('drop the stored key when the address changes and no new key comes with it', () => {
    const { db, dataDir } = setup()
    const made = createConnection(db, dataDir, { provider: 'deepseek', apiKey: 'sk-deepseek-123456789' })
    if (!made.ok) throw new Error('setup')
    updateConnection(db, dataDir, made.connection.id, { model: 'deepseek-pro' })
    expect(readConnectionKey(dataDir, made.connection.id)).toBe('sk-deepseek-123456789')
    updateConnection(db, dataDir, made.connection.id, { baseURL: 'https://evil.example.com/v1' })
    expect(readConnectionKey(dataDir, made.connection.id)).toBe('')
  })
})

describe('each teammate on its own model', () => {
  it('uses the default connection until it picks another one, then that connection’s key, API and model', () => {
    const { db, dataDir, startup, env } = setup()
    saveSettings(db, { provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash' })
    saveApiKey(dataDir, 'sk-main-1234567890')
    expect(botConfig(startup, env, db, scout.id)).toMatchObject({ api: 'chat', model: 'deepseek-flash', apiKey: 'sk-main-1234567890' })

    const made = createConnection(db, dataDir, { provider: 'anthropic', apiKey: CLAUDE_KEY })
    if (!made.ok) throw new Error('setup')
    expect(setBotLlm(db, scout.id, { connectionId: made.connection.id, model: 'claude-haiku-5-5' })).toMatchObject({ ok: true })
    expect(botConfig(startup, env, db, scout.id)).toMatchObject({
      api: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-haiku-5-5', apiKey: CLAUDE_KEY,
      extraBody: { output_config: { effort: 'medium' } },
    })
    // 另一位没动
    expect(botConfig(startup, env, db, ticker.id)).toMatchObject({ model: 'deepseek-flash', apiKey: 'sk-main-1234567890' })

    // 连接删了：用它的同事回到默认连接
    expect(deleteConnection(db, dataDir, made.connection.id)).toEqual({ ok: true, moved: [scout.id] })
    expect(botLlm(db, scout.id)).toEqual({ connectionId: MAIN, model: null })
    expect(botConfig(startup, env, db, scout.id)).toMatchObject({ model: 'deepseek-flash' })
  })

  it('can switch model on the default connection, unless an environment variable pins the model', () => {
    const open = setup()
    setBotLlm(open.db, scout.id, { connectionId: MAIN, model: 'deepseek-pro' })
    expect(botConfig(open.startup, open.env, open.db, scout.id).model).toBe('deepseek-pro')

    const pinned = setup({ OPENGROKBOT_MODEL: 'qwen3' })
    setBotLlm(pinned.db, scout.id, { connectionId: MAIN, model: 'deepseek-pro' })
    expect(botConfig(pinned.startup, pinned.env, pinned.db, scout.id).model).toBe('qwen3')
  })

  it('rejects unknown teammates and connections', () => {
    const { db } = setup()
    expect(setBotLlm(db, 'ghost', { connectionId: MAIN })).toMatchObject({ ok: false, errors: [{ key: 'botId', code: 'not_found' }] })
    expect(setBotLlm(db, scout.id, { connectionId: 'c-00000000' })).toMatchObject({ ok: false, errors: [{ key: 'connectionId', code: 'not_found' }] })
  })
})

describe('/api/connections', () => {
  function app(env: Record<string, string> = {}) {
    const s = setup(env)
    const seen: { url: string; auth: string | null }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
      if (new URL(String(url)).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }], has_more: false })
      return Response.json({
        id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      })
    }) as typeof fetch
    const llm: LLM = { chat: async () => ({ content: 'hi', toolCalls: [], raw: { role: 'assistant', content: 'hi' } }) }
    const gateway = createApp({ db: s.db, llm, dataDir: s.dataDir, settings: { env: s.env, startedWith: s.startup, fetchImpl } })
    const call = (method: string, path: string, body?: unknown) => gateway.app.request(path, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { ...s, gateway, call, seen }
  }

  it('lists the default connection first, and never sends a key back', async () => {
    const { call } = app()
    const made = await call('POST', '/api/connections', { provider: 'anthropic', apiKey: CLAUDE_KEY })
    expect(made.status).toBe(201)
    const text = await (await call('GET', '/api/connections')).text()
    expect(text).not.toContain(CLAUDE_KEY)
    const body = JSON.parse(text)
    expect(body.connections.map((c: { id: string; builtIn: boolean }) => [c.id === MAIN, c.builtIn])).toEqual([[true, true], [false, false]])
    expect(body.connections[1].key).toEqual({ set: true, masked: 'sk-…mnop', source: 'file' })
    expect(body.bots).toEqual({ [ticker.id]: { connectionId: MAIN, model: null }, [scout.id]: { connectionId: MAIN, model: null } })
  })

  it('assigns a teammate, and the next turn runs on that connection', async () => {
    const { call, db } = app()
    const created = await (await call('POST', '/api/connections', { provider: 'anthropic', apiKey: CLAUDE_KEY })).json() as { created: string }
    const put = await call('PUT', `/api/bots/${scout.id}/llm`, { connectionId: created.created, model: 'claude-haiku-5-5' })
    expect(await put.json()).toEqual({ connectionId: created.created, model: 'claude-haiku-5-5' })
    expect(botLlm(db, scout.id)).toEqual({ connectionId: created.created, model: 'claude-haiku-5-5' })
    expect((await call('PUT', '/api/bots/ghost/llm', { connectionId: MAIN })).status).toBe(404)
  })

  it('tests a connection without sending its stored key to a different address', async () => {
    const { call, seen } = app()
    const created = await (await call('POST', '/api/connections', { provider: 'anthropic', apiKey: CLAUDE_KEY })).json() as { created: string }
    const ok = await (await call('POST', '/api/connections/test', { connectionId: created.created })).json()
    expect(ok).toMatchObject({ ok: true, modelListed: true })
    expect(seen.every((s) => s.auth === `Bearer ${CLAUDE_KEY}`)).toBe(true)
    seen.length = 0
    const moved = await (await call('POST', '/api/connections/test', { connectionId: created.created, baseURL: 'https://elsewhere.example.com' })).json()
    expect(moved).toMatchObject({ ok: false, code: 'bad_key', step: 'models' })
    expect(seen.some((s) => s.auth?.includes(CLAUDE_KEY))).toBe(false)
  })

  it('keeps the default connection under the settings rules: env-pinned fields stay locked', async () => {
    const { call } = app({ OPENGROKBOT_MODEL: 'qwen3' })
    const listed = await (await call('GET', '/api/connections')).json() as { connections: { locked: string[] }[] }
    expect(listed.connections[0]!.locked).toEqual(['model'])
    const res = await call('PATCH', `/api/connections/${MAIN}`, { model: 'other' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ errors: [{ key: 'model', code: 'locked' }] })
    expect((await call('DELETE', `/api/connections/${MAIN}`)).status).toBe(409)
  })

  it('switching the default connection to another provider fills the preset and drops the old key', async () => {
    const { call, dataDir } = app()
    saveApiKey(dataDir, 'sk-old-provider-123456')
    const res = await call('PATCH', `/api/connections/${MAIN}`, { provider: 'anthropic' })
    const body = await res.json() as { connections: { provider: string; api: string; model: string; key: { set: boolean } }[] }
    expect(body.connections[0]).toMatchObject({ provider: 'anthropic', api: 'anthropic', model: 'claude-opus-5-5', key: { set: false } })
  })

  it('moves teammates back to the default when their connection is deleted', async () => {
    const { call } = app()
    const created = await (await call('POST', '/api/connections', { provider: 'deepseek' })).json() as { created: string }
    await call('PUT', `/api/bots/${scout.id}/llm`, { connectionId: created.created })
    const del = await (await call('DELETE', `/api/connections/${created.created}`)).json() as { moved: string[] }
    expect(del.moved).toEqual([scout.id])
  })
})

describe('keys stay with the service they were given for', () => {
  function gateway(env: Record<string, string> = {}) {
    const s = setup(env)
    const seen: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url))
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'grok-4.7' }] })
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
    }) as typeof fetch
    const llm: LLM = { chat: async () => ({ content: 'hi', toolCalls: [], raw: { role: 'assistant', content: 'hi' } }) }
    const app = createApp({ db: s.db, llm, dataDir: s.dataDir, settings: { env: s.env, startedWith: s.startup, fetchImpl } }).app
    const call = (method: string, path: string, body?: unknown) => app.request(path, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { ...s, call, seen }
  }

  it('an env-pinned key pins the service and address too, in both APIs', async () => {
    const { call } = gateway({ OPENGROKBOT_API_KEY: 'xai-key-1234567890' })
    const listed = await (await call('GET', '/api/connections')).json() as { connections: { locked: string[] }[] }
    expect(listed.connections[0]!.locked).toEqual(['provider', 'baseURL', 'apiKey'])
    const viaConnections = await call('PATCH', `/api/connections/${MAIN}`, { provider: 'deepseek' })
    expect(await viaConnections.json()).toMatchObject({ errors: [{ key: 'provider', code: 'locked' }] })
    const viaSettings = await call('PUT', '/api/settings', { provider: 'deepseek', baseURL: 'https://api.deepseek.com' })
    expect(viaSettings.status).toBe(400)
    expect(await viaSettings.json()).toMatchObject({ errors: [{ key: 'provider', code: 'locked' }, { key: 'baseURL', code: 'locked' }] })
  })

  it('the old settings API drops a saved key when the address changes without a new one', async () => {
    const { call, dataDir } = gateway()
    saveApiKey(dataDir, 'sk-old-provider-123456')
    await call('PUT', '/api/settings', { baseURL: 'https://api.deepseek.com' })
    expect(existsSync(join(dataDir, 'llm-key'))).toBe(false)
  })

  it('tests the default connection over the API it really uses', async () => {
    // 全新安装：xAI 的地址，但没在界面上选过服务商——运行时走 OpenAI 兼容口，测试也得走它
    const { call, seen } = gateway()
    const listed = await (await call('GET', '/api/connections')).json() as { connections: { provider: string; api: string }[] }
    expect(listed.connections[0]).toMatchObject({ provider: 'xai', api: 'chat' })
    await call('POST', '/api/connections/test', { connectionId: MAIN, apiKey: 'xai-key-1234567890' })
    expect(seen.some((u) => u.endsWith('/chat/completions'))).toBe(true)
    expect(seen.some((u) => u.endsWith('/responses'))).toBe(false)
  })
})

describe('switching a connection to another service', () => {
  it('drops the models teammates picked on it, and takes the new preset’s name and vision', () => {
    const { db, dataDir, startup, env } = setup()
    const made = createConnection(db, dataDir, { provider: 'custom', baseURL: 'https://llm.example.com/v1', model: 'house-model', vision: false })
    if (!made.ok) throw new Error('setup')
    setBotLlm(db, scout.id, { connectionId: made.connection.id, model: 'house-model-large' })
    const moved = updateConnection(db, dataDir, made.connection.id, { provider: 'anthropic', apiKey: CLAUDE_KEY })
    expect(moved.ok && moved.connection).toMatchObject({ name: 'Claude', api: 'anthropic', model: 'claude-opus-5-5', vision: true })
    expect(botLlm(db, scout.id)).toEqual({ connectionId: made.connection.id, model: null })
    expect(botConfig(startup, env, db, scout.id)).toMatchObject({ model: 'claude-opus-5-5', api: 'anthropic' })
  })

  it('does the same for teammates on the default connection', async () => {
    const { db, startup, env, dataDir } = setup()
    setBotLlm(db, scout.id, { connectionId: MAIN, model: 'grok-4.3' })
    const gw = createApp({ db, llm: { chat: async () => ({ content: '', toolCalls: [], raw: { role: 'assistant', content: '' } }) }, dataDir, settings: { env, startedWith: startup } })
    await gw.app.request(`/api/connections/${MAIN}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'deepseek' }) })
    expect(botLlm(db, scout.id)).toEqual({ connectionId: MAIN, model: null })
  })
})

describe('turns pick the teammate’s own model', () => {
  it('asks llmFor at the start of each turn', async () => {
    const { db } = setup()
    const threadId = ensureDmThread(db, scout.id)
    const reply: AssistantTurn = { content: 'From Claude.', toolCalls: [], raw: { role: 'assistant', content: 'From Claude.' } }
    const own: LLM = { chat: vi.fn(async () => reply) }
    const shared: LLM = { chat: vi.fn(async () => reply) }
    const gateway = createApp({ db, llm: shared, llmFor: () => ({ llm: own, vision: false }) })
    await gateway.app.request(`/api/threads/${threadId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    })
    await vi.waitFor(() => expect(own.chat).toHaveBeenCalled())
    expect(shared.chat).not.toHaveBeenCalled()
  })
})
