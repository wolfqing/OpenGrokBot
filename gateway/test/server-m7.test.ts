import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeComputer } from '../src/computer.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createApp } from '../src/server.js'

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
