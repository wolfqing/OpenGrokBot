import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserProvisioner, BrowserStatus } from '../src/browsers.js'
import { createFakeComputer } from '../src/computer.js'
import { loadConfig } from '../src/config.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createApp } from '../src/server.js'
import { SETTING_DEFAULTS, saveSettings, type Settings } from '../src/settings.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const toolTurn = (name: string, args: unknown, id = 'c1'): AssistantTurn =>
  ({ content: null, toolCalls: [{ id, name, args }], raw: { role: 'assistant', content: null, tool_calls: [] } })
const textTurn: AssistantTurn = { content: 'Done.', toolCalls: [], raw: { role: 'assistant', content: 'Done.' } }

describe('settings changed while the gateway runs', () => {
  it('turns vision on or off from the next turn, without a restart', async () => {
    const script = [toolTurn('browser_screenshot', {}), textTurn, toolTurn('browser_screenshot', {}), textTurn]
    const calls: ChatMsg[][] = []
    const llm: LLM = { chat: async (messages) => { calls.push(messages.map((m) => ({ ...m }))); return script.shift() ?? textTurn } }
    const db = openDb(':memory:')
    upsertBot(db, bot)
    const threadId = ensureDmThread(db, bot.id)
    const dataDir = mkdtempSync(join(tmpdir(), 'ogb-m7-'))
    const computer = createFakeComputer()
    const pool = createPool({ dataDir, makeComputer: async () => computer })
    let vision = false
    const gateway = createApp({ db, llm, dataDir, pool, vision: () => vision })
    const say = (text: string) => gateway.app.request(`/api/threads/${threadId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    })
    const sawImage = (n: number) => calls[n]!.some((m) => m.images?.length)

    expect((await say('look')).status).toBe(202)
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    await vi.waitFor(() => expect(gateway.isBusy(bot.id)).toBe(false))
    expect(sawImage(1)).toBe(false)

    vision = true
    expect((await say('look again')).status).toBe(202)
    await vi.waitFor(() => expect(calls).toHaveLength(4))
    expect(sawImage(3)).toBe(true)
  })
})

describe('/api/settings', () => {
  const KEY = 'sk-live-abcdef123456'
  function setup(opts: { env?: Record<string, string>; token?: string; replies?: (url: string) => Response; running?: 'local' | 'docker' } = {}) {
    const db = openDb(':memory:')
    const dataDir = mkdtempSync(join(tmpdir(), 'ogb-settings-'))
    const startedWith = loadConfig({ OPENSUPERBOT_DATA: dataDir })
    const seen: { url: string; auth?: string; model?: string }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
        ...(init?.body ? { model: JSON.parse(String(init.body)).model } : {}),
      })
      return opts.replies?.(String(url)) ?? (String(url).endsWith('/models')
        ? new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }))
        : new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })))
    }) as typeof fetch
    const gateway = createApp({
      db, llm: { chat: async () => textTurn }, dataDir, ...(opts.token ? { token: opts.token } : {}),
      ...(opts.running ? { computers: { kind: opts.running } } : {}),
      settings: { env: opts.env ?? {}, startedWith, fetchImpl },
    })
    const call = (method: string, path: string, body?: unknown) => gateway.app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { db, dataDir, call, seen }
  }

  it('shows the defaults and where each value comes from', async () => {
    const { call } = setup()
    const res = await call('GET', '/api/settings')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      values: SETTING_DEFAULTS,
      sources: Object.fromEntries(Object.keys(SETTING_DEFAULTS).map((k) => [k, 'default'])),
      apiKey: { set: false, masked: '', source: 'none' },
      needsRestart: [],
    })
  })

  it('saves settings and the key, and only ever shows the key masked', async () => {
    const { call, dataDir } = setup()
    const res = await call('PUT', '/api/settings', {
      provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: KEY, computers: 'local',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { values: Settings; sources: Record<string, string>; apiKey: unknown; needsRestart: string[] }
    expect(body.values).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', computers: 'local' })
    expect(body.sources.model).toBe('saved')
    expect(body.apiKey).toEqual({ set: true, masked: 'sk-…3456', source: 'file' })
    expect(body.needsRestart).toEqual(['computers']) // 电脑种类要重启才换
    expect(statSync(join(dataDir, 'llm-key')).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(await (await call('GET', '/api/settings')).json())).not.toContain(KEY)
    expect((await call('PUT', '/api/settings', { apiKey: null })).status).toBe(200)
    expect(existsSync(join(dataDir, 'llm-key'))).toBe(false)
  })

  it('asks for a restart only when the computers the gateway would pick actually change', async () => {
    // 启动时 auto、实际跑的是本机：改成 local 不用重启，改成 docker 要
    const { call } = setup({ running: 'local' })
    const restart = async (computers: string) =>
      ((await (await call('PUT', '/api/settings', { computers })).json()) as { needsRestart: string[] }).needsRestart
    expect(await restart('local')).toEqual([])
    expect(await restart('docker')).toEqual(['computers'])
    expect(await restart('auto')).toEqual([])
  })

  it('refuses what env vars pin, bad values and a bad key, and then saves nothing', async () => {
    const { call, dataDir } = setup({ env: { OPENSUPERBOT_MODEL: 'qwen3', OPENSUPERBOT_API_KEY: 'sk-env-key-0000' } })
    const locked = await call('PUT', '/api/settings', { model: 'deepseek-chat', apiKey: KEY, language: 'zh-CN' })
    expect(locked.status).toBe(400)
    expect(await locked.json()).toEqual({
      error: 'invalid_settings', errors: [{ key: 'model', code: 'locked' }, { key: 'apiKey', code: 'locked' }],
    })
    const after = await (await call('GET', '/api/settings')).json() as { values: Settings; sources: Record<string, string>; apiKey: unknown }
    expect(after.values.language).toBe('') // 同一批里的合法项也没存
    expect(after.sources.model).toBe('env')
    expect(after.apiKey).toEqual({ set: true, masked: 'sk-…0000', source: 'env' })
    expect(existsSync(join(dataDir, 'llm-key'))).toBe(false)

    const bad = setup()
    const res = await bad.call('PUT', '/api/settings', { model: '', apiKey: 'sk with space', whatever: 1 })
    expect(res.status).toBe(400)
    expect((await res.json() as { errors: unknown[] }).errors).toEqual([
      { key: 'apiKey', code: 'invalid' }, { key: 'model', code: 'invalid' }, { key: 'whatever', code: 'unknown_setting' },
    ])
    expect((await bad.call('PUT', '/api/settings', ['model'])).status).toBe(400)
  })

  it('tests a key before it is saved, and never sends the saved key to a different provider', async () => {
    const { call, seen } = setup()
    await call('PUT', '/api/settings', { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: KEY })

    const candidate = await call('POST', '/api/settings/test', { baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k2', apiKey: 'sk-kimi-999999' })
    expect(await candidate.json()).toMatchObject({ ok: true })
    expect(seen.at(-1)).toMatchObject({ url: 'https://api.moonshot.cn/v1/chat/completions', auth: 'Bearer sk-kimi-999999', model: 'kimi-k2' })

    seen.length = 0
    await call('POST', '/api/settings/test', { baseURL: 'https://api.moonshot.cn/v1' })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((s) => s.auth === undefined)).toBe(true)

    seen.length = 0
    await call('POST', '/api/settings/test', {})
    expect(seen.at(-1)).toMatchObject({ url: 'https://api.deepseek.com/v1/chat/completions', auth: `Bearer ${KEY}`, model: 'deepseek-chat' })

    const invalid = await call('POST', '/api/settings/test', { baseURL: 'file:///etc/passwd' })
    expect(invalid.status).toBe(400)
  })

  it('reports a failed test as a result with a code, not as an HTTP error', async () => {
    const { call } = setup({ replies: () => new Response('{"error":"bad key"}', { status: 401 }) })
    const res = await call('POST', '/api/settings/test', { apiKey: KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, code: 'bad_key', step: 'models' })
  })

  it('lists the models of the saved provider', async () => {
    const { call, seen } = setup()
    await call('PUT', '/api/settings', { baseURL: 'https://api.deepseek.com/v1', apiKey: KEY })
    expect(await (await call('GET', '/api/settings/models')).json()).toEqual({ ok: true, models: ['deepseek-chat'] })
    expect(seen.at(-1)).toMatchObject({ url: 'https://api.deepseek.com/v1/models', auth: `Bearer ${KEY}` })
  })

  it('is behind the gateway token like the rest of the API', async () => {
    const { call } = setup({ token: 'tok-123' })
    expect((await call('GET', '/api/settings')).status).toBe(200)
    const db = openDb(':memory:')
    const dataDir = mkdtempSync(join(tmpdir(), 'ogb-settings-'))
    const gateway = createApp({ db, llm: { chat: async () => textTurn }, dataDir, token: 'tok-123', settings: { env: {}, startedWith: loadConfig({ OPENSUPERBOT_DATA: dataDir }) } })
    expect((await gateway.app.request('/api/settings')).status).toBe(401)
  })
})

describe('/api/settings/providers', () => {
  it('lists the presets for the wizard, and the test uses a candidate provider\'s fields', async () => {
    const db = openDb(':memory:')
    const dataDir = mkdtempSync(join(tmpdir(), 'ogb-providers-'))
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      return String(url).endsWith('/models')
        ? new Response(JSON.stringify({ data: [] }))
        : new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }))
    }) as typeof fetch
    const gateway = createApp({ db, llm: { chat: async () => textTurn }, dataDir, settings: { env: {}, startedWith: loadConfig({ OPENSUPERBOT_DATA: dataDir }), fetchImpl } })
    const list = await (await gateway.app.request('/api/settings/providers')).json() as { id: string }[]
    expect(list.map((p) => p.id)).toContain('deepseek')
    await gateway.app.request('/api/settings/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-candidate-12345' }),
    })
    expect(bodies.at(-1)).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' } })
    const bad = await gateway.app.request('/api/settings/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'nope' }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('/api/setup', () => {
  function setup(opts: { status?: BrowserStatus; kind?: 'local' | 'docker'; timeZone?: string; docker?: boolean; image?: boolean } = {}) {
    const db = openDb(':memory:')
    const dataDir = mkdtempSync(join(tmpdir(), 'ogb-setup-'))
    let status: BrowserStatus = opts.status ?? { state: 'missing' }
    const listeners: ((s: BrowserStatus) => void)[] = []
    let finish!: () => void
    const ensure = vi.fn(() => {
      status = { state: 'downloading', item: null, percent: null, totalMiB: null }
      listeners.forEach((l) => l(status))
      return new Promise<string>((r) => { finish = () => { status = { state: 'found', executablePath: '/x/chrome', source: 'downloaded' }; listeners.forEach((l) => l(status)); r('/x/chrome') } })
    })
    const browser: BrowserProvisioner = { status: () => status, ensure, onChange: (l) => { listeners.push(l); return () => {} } }
    const startedWith = { ...loadConfig({ OPENSUPERBOT_DATA: dataDir }), timeZone: opts.timeZone ?? 'Europe/Berlin' }
    const gateway = createApp({
      db, llm: { chat: async () => textTurn }, dataDir,
      computers: {
        kind: opts.kind ?? 'local', why: 'docker_image_missing', reason: 'Docker is running but the image is not built',
        sandbox: { available: false, why: 'no sandbox here' },
      },
      settings: { env: {}, startedWith },
      setup: { browser, dockerReachable: async () => opts.docker ?? false, dockerImageReady: async () => opts.image ?? false },
    })
    const sent: unknown[] = []
    gateway.hub.add({ send: (d) => sent.push(JSON.parse(d)) })
    return { db, dataDir, gateway, ensure, sent, finish: () => finish() }
  }
  const get = async (g: ReturnType<typeof setup>) => (await g.gateway.app.request('/api/setup')).json() as Promise<Record<string, any>>

  it('says a fresh install needs the wizard, and what the computers have to work with', async () => {
    const s = setup({ docker: true })
    expect(await get(s)).toEqual({
      needsSetup: true,
      demo: false,
      computers: {
        kind: 'local', choice: 'auto',
        why: 'docker_image_missing', reason: 'Docker is running but the image is not built',
        docker: { reachable: true, imageReady: false },
        browser: { state: 'missing' },
        download: { approxMB: 190, onDiskMB: 370 },
        browserMirror: { current: '', suggested: null },
        sandbox: { available: false, why: 'no sandbox here' },
      },
    })
  })

  it('does not ask about the image when Docker is not running', async () => {
    expect((await get(setup({ docker: false, image: true }))).computers.docker).toEqual({ reachable: false, imageReady: null })
    expect((await get(setup({ docker: true, image: true }))).computers.docker).toEqual({ reachable: true, imageReady: true })
  })

  it('stops asking once the demo is picked', async () => {
    const s = setup()
    saveSettings(s.db, { model: 'stub' })
    expect(await get(s)).toMatchObject({ needsSetup: false, demo: true })
  })

  it('suggests the npmmirror mirror in a mainland China time zone, and says whose it is', async () => {
    const s = setup({ timeZone: 'Asia/Shanghai' })
    expect((await get(s)).computers.browserMirror).toEqual({
      current: '', suggested: { url: 'https://cdn.npmmirror.com/binaries/playwright', owner: 'npmmirror.com' },
    })
  })

  it('downloads the browser ahead of time, once, and pushes progress to the live connection', async () => {
    const s = setup()
    const post = () => s.gateway.app.request('/api/setup/browser', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const first = await post()
    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ browser: { state: 'downloading', item: null, percent: null, totalMiB: null } })
    expect(s.ensure).toHaveBeenCalledTimes(1)
    s.finish()
    await vi.waitFor(() => expect(s.sent).toContainEqual({ type: 'setup.browser', browser: { state: 'found', executablePath: '/x/chrome', source: 'downloaded' } }))
    expect(s.sent[0]).toEqual({ type: 'setup.browser', browser: { state: 'downloading', item: null, percent: null, totalMiB: null } })
    const again = await post()
    expect(again.status).toBe(200)
    expect(s.ensure).toHaveBeenCalledTimes(1) // 已经有了就不再下
  })
})
