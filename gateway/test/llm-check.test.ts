import { describe, expect, it } from 'vitest'
import { checkConnection, listModels } from '../src/llm-check.js'

type Reply = { status: number; body: unknown } | 'network' | 'hang'
type Call = { url: string; auth?: string; body?: Record<string, unknown> }

/** 按路径回话：/models 和 /chat/completions 各给一串回复，按顺序用 */
function fakeProvider(replies: { models?: Reply[]; chat?: Reply[] }) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({
      url: u,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    })
    const queue = u.endsWith('/models') ? replies.models : replies.chat
    const next = queue?.shift() ?? { status: 500, body: 'no reply scripted' }
    if (next === 'network') throw new TypeError('fetch failed')
    if (next === 'hang') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    }
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body)
    return new Response(text, { status: next.status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const target = { baseURL: 'https://api.example.com/v1', apiKey: 'sk-test-123456', model: 'chat-1' }
const modelsOk = { status: 200, body: { data: [{ id: 'chat-2' }, { id: 'chat-1' }, { id: 'chat-1' }] } }
const chatOk = { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'OK' } }] } }

describe('listModels', () => {
  it('lists what the provider offers, sorted and de-duplicated, sending the key', async () => {
    const { fetchImpl, calls } = fakeProvider({ models: [modelsOk] })
    expect(await listModels(target, { fetchImpl })).toEqual({ ok: true, models: ['chat-1', 'chat-2'] })
    expect(calls[0]).toMatchObject({ url: 'https://api.example.com/v1/models', auth: 'Bearer sk-test-123456' })
  })

  it('sends no Authorization header when there is no key (a local Ollama)', async () => {
    const { fetchImpl, calls } = fakeProvider({ models: [{ status: 200, body: { data: [{ id: 'qwen3' }] } }] })
    await listModels({ baseURL: 'http://127.0.0.1:11434/v1', apiKey: '' }, { fetchImpl })
    expect(calls[0]!.auth).toBeUndefined()
  })

  it('says why it could not list', async () => {
    const run = async (reply: Reply) => listModels(target, { fetchImpl: fakeProvider({ models: [reply] }).fetchImpl, timeoutMs: 50 })
    expect(await run({ status: 401, body: 'nope' })).toMatchObject({ ok: false, code: 'bad_key', status: 401 })
    expect(await run('network')).toMatchObject({ ok: false, code: 'unreachable' })
    expect(await run('hang')).toMatchObject({ ok: false, code: 'timeout' })
    expect(await run({ status: 500, body: 'boom' })).toMatchObject({ ok: false, code: 'provider_error', status: 500 })
  })
})

describe('checkConnection', () => {
  it('passes when the key works and the model answers, with a tiny request', async () => {
    const { fetchImpl, calls } = fakeProvider({ models: [modelsOk], chat: [chatOk] })
    expect(await checkConnection(target, { fetchImpl })).toEqual({ ok: true, models: ['chat-1', 'chat-2'], modelListed: true })
    const chat = calls.find((c) => c.url.endsWith('/chat/completions'))!
    expect(chat.body).toMatchObject({ model: 'chat-1', max_tokens: 16 })
    expect(chat.body!.tools).toBeUndefined()
  })

  it('still tries the model when the provider has no model list', async () => {
    const { fetchImpl } = fakeProvider({ models: [{ status: 404, body: 'not here' }], chat: [chatOk] })
    expect(await checkConnection(target, { fetchImpl })).toEqual({ ok: true, models: [], modelListed: null })
  })

  it('stops at a rejected key without spending a model call', async () => {
    const { fetchImpl, calls } = fakeProvider({ models: [{ status: 401, body: { error: 'invalid api key' } }] })
    expect(await checkConnection(target, { fetchImpl })).toMatchObject({ ok: false, code: 'bad_key', step: 'models' })
    expect(calls).toHaveLength(1)
  })

  it('sorts model-call failures into the cases the wizard explains', async () => {
    const run = async (reply: Reply) => checkConnection(target, { fetchImpl: fakeProvider({ models: [modelsOk], chat: [reply] }).fetchImpl, timeoutMs: 50 })
    expect(await run({ status: 401, body: 'bad' })).toMatchObject({ ok: false, code: 'bad_key', step: 'chat' })
    expect(await run({ status: 402, body: { error: { message: 'Insufficient Balance' } } })).toMatchObject({ code: 'quota' })
    expect(await run({ status: 429, body: { error: { type: 'insufficient_quota' } } })).toMatchObject({ code: 'quota' })
    expect(await run({ status: 429, body: 'slow down' })).toMatchObject({ code: 'rate_limited' })
    expect(await run({ status: 404, body: 'no such model' })).toMatchObject({ code: 'model_not_found' })
    expect(await run({ status: 400, body: { error: { message: 'Model Not Exist' } } })).toMatchObject({ code: 'model_not_found' })
    expect(await run({ status: 400, body: { error: { message: 'The model `chat-1` does not exist' } } })).toMatchObject({ code: 'model_not_found' })
    expect(await run({ status: 503, body: 'overloaded' })).toMatchObject({ code: 'provider_error', status: 503, detail: 'overloaded' })
    expect(await run('network')).toMatchObject({ code: 'unreachable', step: 'chat' })
    expect(await run('hang')).toMatchObject({ code: 'timeout', step: 'chat' })
  })

  it('falls back to max_completion_tokens for models that refuse max_tokens', async () => {
    const { fetchImpl, calls } = fakeProvider({
      models: [modelsOk],
      chat: [{ status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } } }, chatOk],
    })
    expect((await checkConnection(target, { fetchImpl })).ok).toBe(true)
    const chats = calls.filter((c) => c.url.endsWith('/chat/completions'))
    expect(chats[1]!.body).toMatchObject({ max_completion_tokens: 16 })
    expect(chats[1]!.body!.max_tokens).toBeUndefined()
  })

  it('notes a model that is not in the list but answers anyway', async () => {
    const { fetchImpl } = fakeProvider({ models: [{ status: 200, body: { data: [{ id: 'other' }] } }], chat: [chatOk] })
    expect(await checkConnection(target, { fetchImpl })).toEqual({ ok: true, models: ['other'], modelListed: false })
  })

  it('never echoes the key back in the error detail', async () => {
    const { fetchImpl } = fakeProvider({ models: [modelsOk], chat: [{ status: 500, body: `bad key sk-test-123456 for you` }] })
    const result = await checkConnection(target, { fetchImpl })
    expect(JSON.stringify(result)).not.toContain('sk-test-123456')
  })

  it('needs no network for the demo model', async () => {
    const { fetchImpl, calls } = fakeProvider({})
    expect(await checkConnection({ ...target, model: 'stub' }, { fetchImpl })).toEqual({ ok: true, models: [], modelListed: null })
    expect(calls).toHaveLength(0)
  })
})

describe('checkConnection with provider fields', () => {
  it('sends the same provider-specific fields the gateway will send', async () => {
    const { fetchImpl, calls } = fakeProvider({ models: [modelsOk], chat: [chatOk] })
    await checkConnection({ ...target, extraBody: { thinking: { type: 'disabled' }, model: 'nope' } }, { fetchImpl })
    const chat = calls.find((c) => c.url.endsWith('/chat/completions'))!
    expect(chat.body).toMatchObject({ thinking: { type: 'disabled' }, model: 'chat-1' })
  })
})

describe('providers that answer a bad key with 400', () => {
  // xAI 实测（2026-11-03）：/models 和对话都回 400 + 「Incorrect API key provided」
  const xaiBadKey = { status: 400, body: { code: 'invalid-argument', error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.' } }

  it('still calls it a bad key, and stops before the model call', async () => {
    const { fetchImpl, calls } = fakeProvider({ models: [xaiBadKey] })
    expect(await checkConnection(target, { fetchImpl })).toMatchObject({ ok: false, code: 'bad_key', step: 'models', status: 400 })
    expect(calls).toHaveLength(1)
    const chat = fakeProvider({ models: [modelsOk], chat: [xaiBadKey] })
    expect(await checkConnection(target, { fetchImpl: chat.fetchImpl })).toMatchObject({ code: 'bad_key', step: 'chat' })
  })
})
