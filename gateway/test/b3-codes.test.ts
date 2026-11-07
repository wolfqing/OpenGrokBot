import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runTurn, type AgentEvents } from '../src/agent.js'
import { blockText, destinationProblem, destinationReason, rememberReason } from '../src/approvals.js'
import { CodedError, errorBody } from '../src/coded-error.js'
import { createFakeComputer } from '../src/computer.js'
import { ensureDmThread, listMessages, openDb, upsertBot, type MessageRow } from '../src/db.js'
import type { AssistantTurn, LLM } from '../src/llm.js'
import { limitText, noticeText } from '../src/notices.js'
import { createPool } from '../src/pool.js'
import { buildSystemPrompt, languageNote } from '../src/prompts.js'
import { createApp, type ComputersInfo } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { saveSettings } from '../src/settings.js'
import { sandboxHint, sandboxMissing } from '../src/sandbox.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const textTurn = (content: string): AssistantTurn => ({ content, toolCalls: [], raw: { role: 'assistant', content } })
const shellTurn = (n: number): AssistantTurn =>
  ({ content: null, toolCalls: [{ id: `c${n}`, name: 'browser_back', args: {} }], raw: { role: 'assistant', content: null, tool_calls: [] } })

function setup(script: AssistantTurn[] | (() => never)) {
  const db = openDb(':memory:')
  upsertBot(db, { ...bot, created_at: 1 } as never)
  const threadId = ensureDmThread(db, bot.id)
  const events: AgentEvents = { onMessage: (_m: MessageRow) => {}, onStatus: () => {} }
  const llm: LLM = {
    async chat() {
      if (typeof script === 'function') return script()
      const next = script.shift()
      if (!next) throw new Error('script exhausted')
      return next
    },
  }
  const last = () => listMessages(db, threadId).at(-1)!
  return { db, threadId, events, llm, last }
}

describe('notices the gateway says for a teammate', () => {
  it('keep their English text for the model, and carry a code the UI translates', async () => {
    const stop = new AbortController()
    stop.abort()
    const s = setup([])
    await runTurn({ db: s.db, llm: s.llm, bot, soul: '', threadId: s.threadId, signal: stop.signal }, 'go', s.events)
    expect(s.last()).toMatchObject({ kind: 'text', content: '⏹ Stopped. Tell me when to pick it back up.', payload: { notice: 'stopped' } })
  })

  it('an error names the teammate and keeps the raw detail', async () => {
    const s = setup(() => { throw new Error('upstream 502') })
    await runTurn({ db: s.db, llm: s.llm, bot, soul: '', threadId: s.threadId }, 'go', s.events)
    expect(s.last()).toMatchObject({
      content: '⚠️ Scout hit an error: upstream 502',
      payload: { notice: 'error', params: { name: 'Scout', detail: 'upstream 502' } },
    })
  })

  it('a pause at the step limit keeps what the teammate said as the lead', async () => {
    const s = setup([shellTurn(1), shellTurn(2), textTurn('Two pages done.')])
    await runTurn({ db: s.db, llm: s.llm, bot, soul: '', threadId: s.threadId, maxSteps: 2, getComputer: async () => createFakeComputer() }, 'go', s.events)
    expect(s.last()).toMatchObject({
      content: 'Two pages done.\n\n⏸ Paused at the 2-step limit for one turn. Say "continue" to pick it up.',
      payload: { notice: 'paused', params: { limit: 'steps', count: 2 }, lead: 'Two pages done.' },
    })
  })

  it('a budget hit carries the numbers; an old-style string still works', async () => {
    const s = setup([])
    await runTurn({
      db: s.db, llm: s.llm, bot, soul: '', threadId: s.threadId,
      checkBudget: () => ({ text: 'ignored', name: 'Scout', used: 200_500, budget: 200_000 }),
    }, 'go', s.events)
    expect(s.last()).toMatchObject({
      content: "⚠️ Scout hit today's token budget (200,500 of 200,000 tokens). It picks up again tomorrow — or raise OPENSUPERBOT_DAILY_TOKENS.",
      payload: { notice: 'budget', params: { name: 'Scout', used: 200_500, budget: 200_000 } },
    })
    const old = setup([])
    await runTurn({ db: old.db, llm: old.llm, bot, soul: '', threadId: old.threadId, checkBudget: () => 'over budget' }, 'go', old.events)
    expect(old.last()).toMatchObject({ content: 'over budget', payload: null })
  })

  it('say limits the same way the model is told about them', () => {
    expect(limitText('minutes', 15)).toBe('the 15-minute limit for one turn')
    expect(noticeText({ notice: 'paused', params: { limit: 'seconds', count: 30 } }))
      .toBe('⏸ Paused at the 30-second limit for one turn. Say "continue" to pick it up.')
  })
})

describe('why a release cannot become a rule', () => {
  it('has a code and the values to fill in, and the same English as before', () => {
    expect(destinationReason('message', '*')).toEqual({ code: 'wildcard', target: '*' })
    expect(destinationReason('email', 'bob at acme')).toEqual({ code: 'not_one_email', target: 'bob at acme' })
    expect(destinationReason('message', 'x'.repeat(300))).toEqual({ code: 'too_long', max: 200 })
    expect(rememberReason({ kind: 'purchase', target: 'amazon.com' })).toEqual({ code: 'always_asks' })
    expect(destinationProblem('message', '*')).toBe('"*" is a wildcard, not one destination')
    expect(blockText({ code: 'batch' })).toBe('a batch always asks, item by item')
  })
})

describe('the language note in the system prompt', () => {
  it('asks for the interface language, and falls back to following the operator', () => {
    expect(languageNote('zh-CN')).toMatch(/interface is in Simplified Chinese\. Write to them in Simplified Chinese/)
    expect(languageNote('en')).toMatch(/in English/)
    expect(languageNote('')).toBe('Write to your operator in the language they write to you in.')
    expect(buildSystemPrompt(bot as never, '', { language: 'zh-CN' })).toContain('Simplified Chinese')
  })
})

describe('coded errors', () => {
  it('give the UI a code and values, and stay plain errors for everything else', () => {
    const err = new CodedError('name_taken', 'A teammate called Scout already exists.', { name: 'Scout' })
    expect(err).toBeInstanceOf(Error)
    expect(errorBody(err)).toEqual({ error: 'A teammate called Scout already exists.', code: 'name_taken', params: { name: 'Scout' } })
    expect(errorBody(new Error('boom'))).toEqual({ error: 'boom' })
  })

  it('say why there is no sandbox as a code too', () => {
    expect(sandboxMissing('linux')).toBe('install_bwrap')
    expect(sandboxMissing('darwin')).toBe('no_sandbox_exec')
    expect(sandboxMissing('win32')).toBe('unsupported_os')
    expect(sandboxHint('linux')).toMatch(/bubblewrap/)
  })
})

describe('errors the UI shows, with codes', () => {
  const json = (method: string, body: unknown): RequestInit =>
    ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  function app(opts: { computers?: ComputersInfo; make?: () => Promise<ReturnType<typeof createFakeComputer>> } = {}) {
    const db = openDb(':memory:')
    upsertBot(db, bot)
    ensureDmThread(db, bot.id)
    const dataDir = mkdtempSync(join(tmpdir(), 'ogb-b3-'))
    const pool = createPool({ dataDir, makeComputer: opts.make ?? (async () => createFakeComputer({ kind: 'local' })) })
    return createApp({ db, llm: { chat: async () => textTurn('ok') }, dataDir, pool, ...(opts.computers ? { computers: opts.computers } : {}) }).app
  }

  it('hiring a name that is taken', async () => {
    const res = await app().request('/api/bots', json('POST', { name: 'Scout', role: '' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'A teammate called Scout already exists.', code: 'name_taken', params: { name: 'Scout' } })
  })

  it('turning on commands without a sandbox, or with one that fails its check', async () => {
    const none = app({ computers: { kind: 'local', sandbox: { available: false, why: 'Install bubblewrap.', whyCode: 'install_bwrap' } } })
    const res = await none.request('/api/bots/researcher/computer', json('PATCH', { shell: true }))
    expect(await res.json()).toMatchObject({ code: 'no_sandbox', params: { why: 'install_bwrap' } })
    expect(await (await none.request('/api/bots/researcher/computer')).json()).toMatchObject({ shell: { whyCode: 'install_bwrap' } })
    const leaky = app({ computers: { kind: 'local', sandbox: { available: true }, checkSandbox: async () => ({ ok: false, why: 'wrote outside' }) } })
    const failed = await leaky.request('/api/bots/researcher/computer', json('PATCH', { shell: true }))
    expect(await failed.json()).toMatchObject({ code: 'sandbox_check_failed', params: { detail: 'wrote outside' } })
  })

  it('a computer that cannot start for a known reason', async () => {
    const down = app({ make: async () => { throw new CodedError('docker_down', 'Docker is not running.') } })
    expect(await (await down.request('/api/bots/researcher/computer')).json())
      .toMatchObject({ running: false, error: 'Docker is not running.', errorCode: 'docker_down' })
    const odd = app({ make: async () => { throw new Error('something else') } })
    const body = await (await odd.request('/api/bots/researcher/computer')).json() as Record<string, unknown>
    expect(body).toMatchObject({ error: 'something else' })
    expect(body.errorCode).toBeUndefined()
  })
})

describe('the interface language reaches the teammate', () => {
  it('a Chinese interface saved in settings asks the next turn for Chinese', async () => {
    const db = openDb(':memory:')
    upsertBot(db, bot)
    const threadId = ensureDmThread(db, bot.id)
    const dataDir = mkdtempSync(join(tmpdir(), 'ogb-b3-lang-'))
    const prompts: string[] = []
    const llm: LLM = { chat: async (messages) => { prompts.push(String(messages[0]!.content)); return textTurn('好的') } }
    const gateway = createApp({ db, llm, dataDir, settings: { env: {}, startedWith: loadConfig({ OPENSUPERBOT_DATA: dataDir }) } })
    const say = () => gateway.app.request(`/api/threads/${threadId}/messages`, json('POST', { text: 'hi' }))
    function json(method: string, body: unknown): RequestInit {
      return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    }
    await say()
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    await vi.waitFor(() => expect(gateway.isBusy(bot.id)).toBe(false))
    expect(prompts[0]).toContain('Write to your operator in the language they write to you in.')
    saveSettings(db, { language: 'zh-CN' })
    await say()
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    expect(prompts[1]).toContain("Your operator's interface is in Simplified Chinese.")
  })
})
