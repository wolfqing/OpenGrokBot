import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeComputer } from '../src/computer.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { AssistantTurn, LLM } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createRoutine } from '../src/routines.js'
import { createApp } from '../src/server.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const toolTurn = (name: string, args: unknown, id = 'c1'): AssistantTurn =>
  ({ content: null, toolCalls: [{ id, name, args }], raw: { role: 'assistant', content: null, tool_calls: [] } })
const textTurn: AssistantTurn = { content: 'Done.', toolCalls: [], raw: { role: 'assistant', content: 'Done.' } }

function scriptedLLM(script: AssistantTurn[]): LLM {
  return { chat: async () => script.shift() ?? textTurn }
}

/** 一台本机电脑：记着窗口开没开 */
function localComputer() {
  const state = { window: false, shows: 0, hides: 0 }
  const computer = createFakeComputer({
    kind: 'local',
    showWindow: async () => { state.window = true; state.shows += 1 },
    hideWindow: async () => { if (state.window) state.hides += 1; state.window = false },
    windowShown: () => state.window,
  })
  return { computer, state }
}

function setup(llm: LLM) {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  const threadId = ensureDmThread(db, bot.id)
  const dataDir = mkdtempSync(join(tmpdir(), 'ogb-m6-'))
  const { computer, state } = localComputer()
  const pool = createPool({ dataDir, makeComputer: async () => computer })
  const gateway = createApp({ db, llm, dataDir, pool, computers: { kind: 'local' } })
  const say = (text: string) => gateway.app.request(`/api/threads/${threadId}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  })
  return { db, state, computer, gateway, say, threadId }
}

describe('the sign-in window of a local computer', () => {
  it('opens on ask_for_login and stays open while the same turn keeps using the browser', async () => {
    const { state, say, gateway } = setup(scriptedLLM([
      toolTurn('ask_for_login', { site: 'Mail' }),
      toolTurn('browser_screenshot', { caption: 'still looking' }, 'c2'),
      textTurn,
    ]))
    expect((await say('check the mail')).status).toBe(202)
    await vi.waitFor(() => expect(gateway.isBusy(bot.id)).toBe(false))
    expect(state).toMatchObject({ window: true, shows: 1, hides: 0 })
  })

  it('goes back to the background when the operator speaks again, not when a routine fires', async () => {
    const { state, say, gateway, db } = setup(scriptedLLM([toolTurn('ask_for_login', { site: 'Mail' }), textTurn, textTurn, textTurn]))
    await say('check the mail')
    await vi.waitFor(() => expect(state.window).toBe(true))
    await vi.waitFor(() => expect(gateway.isBusy(bot.id)).toBe(false))
    const routine = createRoutine(db, { botId: bot.id, name: 'tick', cron: '0 9 * * *', instructions: 'look' })
    expect(await gateway.runRoutine(routine)).toBe('ran')
    expect(state.window).toBe(true) // 人可能正在窗口里敲密码：routine 不动它
    await say('done, carry on')
    await vi.waitFor(() => expect(state.window).toBe(false))
    expect(state.hides).toBe(1)
  })
})

describe('tools and briefing of a local computer', () => {
  it('describe the shell by its real working directory and tell the model to wait after ask_for_login', async () => {
    const { buildTools } = await import('../src/tools.js')
    const shell = buildTools({ hasComputer: true, kind: 'local' }).find((t) => t.function.name === 'shell')!
    expect(shell.function.description).toMatch(/workspace folder.*\$HOME/)
    expect(shell.function.description).not.toMatch(/Working directory is \/workspace/)
    expect(buildTools({ hasComputer: true }).find((t) => t.function.name === 'shell')!.function.description).toMatch(/Working directory is \/workspace/)
    const login = buildTools({ hasComputer: true }).find((t) => t.function.name === 'ask_for_login')!
    expect(login.function.description).toMatch(/stop and wait/)
    expect(login.function.description).not.toMatch(/take over your screen/)
    const { computerBriefing } = await import('../src/prompts.js')
    expect(computerBriefing({ kind: 'local' })).toMatch(/opens as a window on their desktop[\s\S]*stop and wait/)
    expect(computerBriefing()).toMatch(/take over your screen/)
  })
})
