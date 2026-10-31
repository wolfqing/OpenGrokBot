import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeComputer } from '../src/computer.js'
import { openDb, upsertBot } from '../src/db.js'
import type { LLM } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createApp } from '../src/server.js'
import type { WorkflowRecording } from '../src/workflow-recorder.js'
import { parseWorkflowTrace } from '../src/workflows.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const llm: LLM = { chat: async () => ({ content: 'ok', toolCalls: [], raw: { role: 'assistant', content: 'ok' } }) }

describe('workflow recording API', () => {
  it('records on the bot computer, persists redacted traces, and serves them by teammate', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ogb-workflow-api-'))
    const db = openDb(':memory:')
    upsertBot(db, bot)
    let stopCalls = 0
    const computer = createFakeComputer({
      startWorkflowRecording: async (title): Promise<WorkflowRecording> => ({
        async stop() {
          stopCalls += 1
          return parseWorkflowTrace({
            format: 'opengrokbot.workflow', version: 1, title, steps: [
              { type: 'fill', target: { label: 'API token' }, value: { kind: 'literal', text: 'should-never-persist' } },
              { type: 'click', target: { role: { role: 'button', name: 'Save' } } },
            ],
          })
        },
      }),
    })
    const pool = createPool({ dataDir, makeComputer: async () => computer })
    const { app, isBusy } = createApp({ db, llm, pool, dataDir })

    try {
      expect((await app.request('/api/bots/missing/workflows')).status).toBe(404)
      expect((await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '   ' }),
      })).status).toBe(400)

      const start = await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Submit a form' }),
      })
      expect(start.status).toBe(202)
      expect(await start.json()).toEqual({ ok: true, recording: true })
      expect(isBusy('researcher')).toBe(true)
      expect((await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Second recording' }),
      })).status).toBe(409)

      const computerState = await app.request('/api/bots/researcher/computer')
      expect(await computerState.json()).toMatchObject({ workflowRecording: true })

      const stop = await app.request('/api/bots/researcher/workflows/recording/stop', { method: 'POST' })
      expect(stop.status).toBe(200)
      const saved = await stop.json() as { id: string; trace: { steps: unknown[] } }
      expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(saved.trace.steps).toHaveLength(2)
      expect(JSON.stringify(saved)).not.toContain('should-never-persist')
      expect(stopCalls).toBe(1)
      expect(isBusy('researcher')).toBe(false)

      const list = await app.request('/api/bots/researcher/workflows')
      expect(await list.json()).toEqual([saved])
      const read = await app.request(`/api/bots/researcher/workflows/${saved.id}`)
      expect(await read.json()).toEqual(saved.trace)
      expect((await app.request('/api/bots/researcher/workflows/recording/stop', { method: 'POST' })).status).toBe(409)
    } finally {
      await pool.disposeAll()
      db.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('reserves a teammate before async browser startup so concurrent starts cannot leak a recorder', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ogb-workflow-race-'))
    const db = openDb(':memory:')
    upsertBot(db, bot)
    let release: ((recorder: WorkflowRecording) => void) | undefined
    let starts = 0
    const computer = createFakeComputer({
      startWorkflowRecording: async () => {
        starts += 1
        return new Promise<WorkflowRecording>((resolve) => { release = resolve })
      },
    })
    const pool = createPool({ dataDir, makeComputer: async () => computer })
    const { app } = createApp({ db, llm, pool, dataDir })
    try {
      const first = app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'First' }),
      })
      await vi.waitFor(() => expect(starts).toBe(1))
      const second = await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Second' }),
      })
      expect(second.status).toBe(409)
      expect(starts).toBe(1)
      release?.({ stop: async () => parseWorkflowTrace({ format: 'opengrokbot.workflow', version: 1, title: 'First', steps: [] }) })
      expect((await first).status).toBe(202)
      expect((await app.request('/api/bots/researcher/workflows/recording/stop', { method: 'POST' })).status).toBe(200)
    } finally {
      await pool.disposeAll()
      db.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
