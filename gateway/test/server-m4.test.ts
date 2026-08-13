import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseA2AAllow } from '../src/a2a.js'
import { ensureDmThread, ensureGroupThread, listMessages, openDb, upsertBot } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { createApp } from '../src/server.js'

const scout = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const ticker = { id: 'market-watch', name: 'Ticker', role: 'markets', emoji: '📈', soul_path: '' }
const chief = { id: 'chief', name: 'Chief', role: 'staff', emoji: '🎖️', soul_path: '' }
const GROUP = 'group:offsite-crew'

type App = { request: (path: string, init?: RequestInit) => Promise<Response> | Response }
const post = (app: App, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const whoAmI = (messages: ChatMsg[]) => String(messages[0]?.content ?? '').match(/You are ([\w -]+),/)?.[1] ?? '?'

/** 每个 bot 回一句带自己名字的话，方便断言顺序与上下文。 */
function namingLLM(): LLM & { seen: { system: string; who: string; history: ChatMsg[] }[] } {
  const seen: { system: string; who: string; history: ChatMsg[] }[] = []
  return {
    seen,
    async chat(messages: ChatMsg[]) {
      const who = whoAmI(messages)
      seen.push({ system: String(messages[0]?.content ?? ''), who, history: [...messages] })
      const content = `${who} reporting.`
      return { content, toolCalls: [], raw: { role: 'assistant', content } } as AssistantTurn
    },
  }
}

function setup(llm: LLM, a2a = '') {
  const db = openDb(':memory:')
  for (const b of [scout, ticker, chief]) upsertBot(db, b)
  for (const b of [scout, ticker, chief]) ensureDmThread(db, b.id)
  ensureGroupThread(db, GROUP, 'Offsite crew', ['researcher', 'market-watch', 'chief'])
  const dataDir = mkdtempSync(join(tmpdir(), 'ogb-m4-'))
  return {
    db, dataDir,
    ...createApp({ db, llm, dataDir, chiefId: 'chief', a2aRules: parseA2AAllow(a2a, 'chief') }),
  }
}

describe('GET /api/conversations', () => {
  it('lists dms and the group', async () => {
    const { app } = setup(namingLLM())
    const rows = (await (await app.request('/api/conversations')).json()) as { id: string; kind: string; title: string }[]
    expect(rows.map((r) => r.id)).toContain(GROUP)
    expect(rows.find((r) => r.id === GROUP)).toMatchObject({ kind: 'group', title: 'Offsite crew' })
  })
})

describe('group orchestration', () => {
  it('runs every member once, with the chief last', async () => {
    const { app, db } = setup(namingLLM())
    await post(app, `/api/threads/${GROUP}/messages`, { text: 'where are we?' })
    await vi.waitFor(() => {
      expect(listMessages(db, GROUP).filter((m) => m.sender !== 'user')).toHaveLength(3)
    })
    expect(listMessages(db, GROUP).map((m) => m.sender)).toEqual(['user', 'researcher', 'market-watch', 'chief'])
  })

  it('lets a later speaker see what the earlier ones said', async () => {
    const llm = namingLLM()
    const { app, db } = setup(llm)
    await post(app, `/api/threads/${GROUP}/messages`, { text: 'where are we?' })
    await vi.waitFor(() => { expect(listMessages(db, GROUP)).toHaveLength(4) })

    const chiefTurn = llm.seen[llm.seen.length - 1]!
    expect(chiefTurn.who).toBe('Chief')
    expect(chiefTurn.system).toContain('Offsite crew')
    // 前两位的发言必须以"同事说的话"出现在 Chief 的上下文里
    const colleagues = chiefTurn.history.filter((m) => (m.content ?? '').startsWith('@'))
    expect(colleagues.map((m) => m.content)).toEqual([
      '@researcher: Scout reporting.',
      '@market-watch: Ticker reporting.',
    ])
  })

  it('posts exactly one user bubble for the whole round', async () => {
    const { app, db } = setup(namingLLM())
    await post(app, `/api/threads/${GROUP}/messages`, { text: 'where are we?' })
    await vi.waitFor(() => { expect(listMessages(db, GROUP)).toHaveLength(4) })
    expect(listMessages(db, GROUP).filter((m) => m.sender === 'user')).toHaveLength(1)
  })

  it('404s an unknown group', async () => {
    const { app } = setup(namingLLM())
    expect((await post(app, '/api/threads/group:nope/messages', { text: 'hi' })).status).toBe(404)
  })
})

describe('a2a delivery', () => {
  function relayLLM(from: string, to: string): LLM {
    const handed = new Set<string>()
    return {
      async chat(messages: ChatMsg[]) {
        const who = whoAmI(messages)
        if (who === from && !handed.has(from)) {
          handed.add(from)
          return {
            content: null,
            toolCalls: [{ id: 'c1', name: 'message_bot', args: { to, content: 'price the tiers by Friday' } }],
            raw: { role: 'assistant', content: null, tool_calls: [] },
          } as AssistantTurn
        }
        const content = `${who} acknowledges.`
        return { content, toolCalls: [], raw: { role: 'assistant', content } } as AssistantTurn
      },
    }
  }

  it('drops a bot_ref chip into the target thread and wakes it up', async () => {
    const { app, db } = setup(relayLLM('Chief', 'market-watch'))
    await post(app, '/api/threads/dm:chief/messages', { text: 'get me pricing' })
    await vi.waitFor(() => {
      expect(listMessages(db, 'dm:market-watch').some((m) => m.kind === 'bot_ref')).toBe(true)
    })
    expect(listMessages(db, 'dm:market-watch').find((m) => m.kind === 'bot_ref')!.payload)
      .toEqual({ from: 'chief', fromName: 'Chief', content: 'price the tiers by Friday' })

    await vi.waitFor(() => {
      expect(listMessages(db, 'dm:market-watch').some((m) => m.sender === 'market-watch')).toBe(true)
    })
    // 被叫醒的一方不该冒出假的用户气泡
    expect(listMessages(db, 'dm:market-watch').every((m) => m.sender !== 'user')).toBe(true)
  })

  it('refuses a relay that is not allowlisted', async () => {
    const { app, db } = setup(relayLLM('Scout', 'market-watch')) // 未配置 researcher>market-watch
    await post(app, '/api/threads/dm:researcher/messages', { text: 'hand it to ticker' })
    await vi.waitFor(() => {
      expect(listMessages(db, 'dm:researcher').some((m) => m.sender === 'researcher')).toBe(true)
    })
    expect(listMessages(db, 'dm:market-watch')).toHaveLength(0)
  })

  it('delivers a peer relay once the pair is allowlisted', async () => {
    const { app, db } = setup(relayLLM('Scout', 'market-watch'), 'researcher>market-watch')
    await post(app, '/api/threads/dm:researcher/messages', { text: 'hand it to ticker' })
    await vi.waitFor(() => {
      expect(listMessages(db, 'dm:market-watch').some((m) => m.kind === 'bot_ref')).toBe(true)
    })
  })
})
