import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createLLM, type ChatMsg, type ToolDef } from '../src/llm.js'
import { echoBlocks, screenshotsToHide, toAnthropic } from '../src/llm-anthropic.js'

type Sent = { url: string; headers: Headers; body: Record<string, unknown> }

/** 装成 Anthropic 的服务端：记下收到的请求，按顺序回预先写好的回复 */
function fakeAnthropic(replies: (Record<string, unknown> | { status: number; body: unknown })[]) {
  const sent: Sent[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) })
    const next = replies.shift() ?? {}
    const status = 'status' in next && typeof next.status === 'number' ? next.status : 200
    const body = 'status' in next && typeof next.status === 'number' ? next.body : next
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { sent, fetchImpl }
}

const message = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
  content, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }, ...extra,
})

const target = (extra: Partial<ReturnType<typeof loadConfig>> = {}) => ({
  ...loadConfig({ OPENSUPERBOT_LLM_RETRIES: '0' }),
  api: 'anthropic' as const, baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-api03-test', model: 'claude-opus-5-5', ...extra,
})

const tools: ToolDef[] = [{ type: 'function', function: { name: 'browser_goto', description: 'Open a page', parameters: { type: 'object', properties: { url: { type: 'string' } } } } }]

describe('Claude (native Messages API)', () => {
  it('sends system, tools and the key through the official SDK, and maps a tool call back', async () => {
    const { sent, fetchImpl } = fakeAnthropic([message([
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'text', text: 'Opening it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'browser_goto', input: { url: 'https://example.com' } },
    ], { stop_reason: 'tool_use' })])
    const llm = createLLM(target(), fetchImpl)
    const turn = await llm.chat([{ role: 'system', content: 'You are Scout.' }, { role: 'user', content: 'open example.com' }], tools)

    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    // SDK 1.x（API 版本 2026-10-21 起）用 Bearer 头带 key，版本头由 SDK 定
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer sk-ant-api03-test')
    expect(sent[0]!.headers.get('anthropic-version')).toBeTruthy()
    expect(sent[0]!.body).toMatchObject({
      model: 'claude-opus-5-5', system: 'You are Scout.', cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'open example.com' }] }],
      tools: [{ name: 'browser_goto', description: 'Open a page', input_schema: { type: 'object' } }],
    })
    expect(turn.content).toBe('Opening it.')
    expect(turn.toolCalls).toEqual([{ id: 'toolu_1', name: 'browser_goto', args: { url: 'https://example.com' } }])
    // 思考块和签名原样留着，下一步要原样发回去
    expect(turn.raw.native?.items).toHaveLength(3)
    expect(turn.usage).toEqual({ prompt: 1050, completion: 20, cached: 900 })
  })

  it('opts into server-side fallback on the official API only, and never for models without it', async () => {
    const official = fakeAnthropic([message([{ type: 'text', text: 'ok' }])])
    await createLLM(target(), official.fetchImpl).chat([{ role: 'user', content: 'hi' }], [])
    expect(official.sent[0]!.body.fallbacks).toBe('default')
    expect(official.sent[0]!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')

    const haiku = fakeAnthropic([message([{ type: 'text', text: 'ok' }])])
    await createLLM(target({ model: 'claude-haiku-5-5' }), haiku.fetchImpl).chat([{ role: 'user', content: 'hi' }], [])
    expect(haiku.sent[0]!.body.fallbacks).toBeUndefined()

    const compatible = fakeAnthropic([message([{ type: 'text', text: 'ok' }])])
    await createLLM(target({ baseURL: 'https://api.minimax.io/anthropic/v1' }), compatible.fetchImpl).chat([{ role: 'user', content: 'hi' }], [])
    expect(compatible.sent[0]!.url).toBe('https://api.minimax.io/anthropic/v1/messages')
    expect(compatible.sent[0]!.body.fallbacks).toBeUndefined()
    expect(compatible.sent[0]!.headers.get('anthropic-beta')).toBeNull()
  })

  it('replays its own blocks untouched on the next step, with the tool result right behind them', async () => {
    const { sent, fetchImpl } = fakeAnthropic([
      message([
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'tool_use', id: 'toolu_1', name: 'browser_goto', input: { url: 'https://example.com' } },
      ], { stop_reason: 'tool_use' }),
      message([{ type: 'text', text: 'Done.' }]),
    ])
    const llm = createLLM(target(), fetchImpl)
    const messages: ChatMsg[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }]
    const first = await llm.chat(messages, tools)
    messages.push(first.raw, { role: 'tool', tool_call_id: 'toolu_1', content: 'Now on example.com' })
    messages.push({ role: 'user', content: 'This is the screenshot you just took.', images: ['data:image/png;base64,AAAA'] })
    await llm.chat(messages, tools)
    expect(sent[1]!.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'tool_use', id: 'toolu_1', name: 'browser_goto', input: { url: 'https://example.com' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Now on example.com' },
        { type: 'text', text: 'This is the screenshot you just took.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ] },
    ])
  })

  it('keeps earlier screenshots as they were (editing history would void the thinking blocks after it)', () => {
    const { messages } = toAnthropic([
      { role: 'user', content: 'shot one', images: ['data:image/png;base64,ONE'] },
      { role: 'assistant', content: 'seen' },
      { role: 'user', content: 'shot two', images: ['data:image/jpeg;base64,TWO'] },
    ])
    const images = messages.flatMap((m) => (m.content as { type: string }[]).filter((b) => b.type === 'image'))
    expect(images).toHaveLength(2)
  })

  it('translates a turn another provider produced (OpenAI-style tool calls) and starts with a user message', () => {
    const { system, messages } = toAnthropic([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: '[steps taken] opened a page' },
      { role: 'user', content: 'and now?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call:abc/1', type: 'function', function: { name: 'browser_goto', arguments: '{"url":"x"}' } }] },
      { role: 'tool', tool_call_id: 'call:abc/1', content: '' },
    ])
    expect(system).toBe('sys')
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '(earlier conversation)' }] })
    expect(messages[3]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_abc_1', name: 'browser_goto', input: { url: 'x' } }] })
    expect(messages[4]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_abc_1', content: '(no output)' }] })
  })

  it('asks for text only with tool_choice none', async () => {
    const { sent, fetchImpl } = fakeAnthropic([message([{ type: 'text', text: 'Summary.' }])])
    await createLLM(target(), fetchImpl).chat([{ role: 'user', content: 'wrap up' }], tools, { toolChoice: 'none' })
    expect(sent[0]!.body.tool_choice).toEqual({ type: 'none' })
  })

  it('turns a safety decline into a readable error instead of an empty reply', async () => {
    const { fetchImpl } = fakeAnthropic([message([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } })])
    await expect(createLLM(target(), fetchImpl).chat([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/declined.*cyber/)
  })

  it('reports provider errors the way the other APIs do, without retrying a rejected request', async () => {
    const { sent, fetchImpl } = fakeAnthropic([{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }])
    await expect(createLLM(target(), fetchImpl).chat([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/^LLM API 401/)
    expect(sent).toHaveLength(1)
  })

  it('drops thinking and tool calls from before a mid-output fallback when echoing them back', () => {
    const kept = echoBlocks([
      { type: 'thinking', thinking: '', signature: 'a' },
      { type: 'text', text: 'partial', citations: null },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal' } },
      { type: 'thinking', thinking: '', signature: 'b' },
      { type: 'text', text: 'rest', citations: null },
    ] as never)
    expect(kept.map((b) => b.type)).toEqual(['text', 'fallback', 'thinking', 'text'])
  })
})

describe('Claude: only the connection’s own credentials, ever', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('never falls back to Anthropic credentials found on this machine when the connection has no key', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-oat01-from-the-machine')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-from-the-machine')
    const { sent, fetchImpl } = fakeAnthropic([message([{ type: 'text', text: 'ok' }])])
    const llm = createLLM(target({ apiKey: '', baseURL: 'https://third-party.example.com/anthropic' }), fetchImpl)
    await expect(llm.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/no API key/)
    expect(sent).toHaveLength(0)
  })

  it('refuses a subscription sign-in token at use time too (env vars, keys saved before this check)', async () => {
    const { sent, fetchImpl } = fakeAnthropic([message([{ type: 'text', text: 'ok' }])])
    await expect(createLLM(target({ apiKey: 'sk-ant-oat01-abcdefghijklmnop' }), fetchImpl).chat([{ role: 'user', content: 'hi' }], []))
      .rejects.toThrow(/subscription sign-in token/)
    expect(sent).toHaveLength(0)
  })

  it('drops custom headers configured on this machine, and adds x-api-key only for compatible third parties', async () => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'X-Corp-Secret: s3cret\nX-Other: 1')
    const official = fakeAnthropic([message([{ type: 'text', text: 'ok' }])])
    await createLLM(target(), official.fetchImpl).chat([{ role: 'user', content: 'hi' }], [])
    expect(official.sent[0]!.headers.get('x-corp-secret')).toBeNull()
    expect(official.sent[0]!.headers.get('x-other')).toBeNull()
    expect(official.sent[0]!.headers.get('x-api-key')).toBeNull()
    const compatible = fakeAnthropic([message([{ type: 'text', text: 'ok' }])])
    await createLLM(target({ baseURL: 'https://api.minimax.io/anthropic' }), compatible.fetchImpl).chat([{ role: 'user', content: 'hi' }], [])
    expect(compatible.sent[0]!.headers.get('x-api-key')).toBe('sk-ant-api03-test')
    expect(compatible.sent[0]!.headers.get('x-corp-secret')).toBeNull()
  })
})

describe('Claude: long browsing turns', () => {
  it('folds old screenshots away in batches of five, so the request stays small and the prefix rarely changes', () => {
    expect([0, 1, 10, 11, 15, 16, 20, 21, 40].map(screenshotsToHide)).toEqual([0, 0, 0, 5, 5, 10, 10, 15, 30])
  })

  it('asks the official API to drop thinking blocks it can no longer match once screenshots were folded away', async () => {
    const shots: ChatMsg[] = Array.from({ length: 11 }, (_, i) => ({ role: 'user', content: `shot ${i}`, images: ['data:image/png;base64,AA'] }))
    const { sent, fetchImpl } = fakeAnthropic([message([{ type: 'text', text: 'ok' }])])
    await createLLM(target(), fetchImpl).chat(shots, [])
    const images = (sent[0]!.body.messages as { content: { type: string }[] }[]).flatMap((m) => m.content.filter((b) => b.type === 'image'))
    expect(images).toHaveLength(6)
    expect(sent[0]!.body.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
    expect(sent[0]!.headers.get('anthropic-beta')).toContain('thinking-binding-controls-2026-08-01')
  })

  it('does not treat a reply cut off at the output limit as a finished step', async () => {
    const { fetchImpl } = fakeAnthropic([message([
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'tool_use', id: 'toolu_1', name: 'browser_goto', input: { url: 'https://exa' } },
    ], { stop_reason: 'max_tokens' })])
    await expect(createLLM(target(), fetchImpl).chat([{ role: 'user', content: 'go' }], tools)).rejects.toThrow(/cut off/)
  })
})
