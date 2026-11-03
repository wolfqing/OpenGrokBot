import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeComputer } from '../src/computer.js'
import { openDb, upsertBot } from '../src/db.js'
import type { LLM } from '../src/llm.js'
import { createPool } from '../src/pool.js'
import { createRoutine } from '../src/routines.js'
import { createApp, WORKFLOW_RECORDING_MAX_MS } from '../src/server.js'
import type { WorkflowRecording } from '../src/workflow-recorder.js'
import { parseWorkflowTrace, type WorkflowTrace } from '../src/workflows.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }
const llm: LLM = { chat: async () => ({ content: 'ok', toolCalls: [], raw: { role: 'assistant', content: 'ok' } }) }

describe('workflow recording API', () => {
  it('keeps a stopped trace in review until the operator edits and saves it to SQLite', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ogb-workflow-api-'))
    const db = openDb(':memory:')
    upsertBot(db, bot)
    let stopCalls = 0
    let startedIntent: string | undefined
    const computer = createFakeComputer({
      startWorkflowRecording: async (title, intent): Promise<WorkflowRecording> => {
        startedIntent = intent
        return ({
        async reattach() {},
        async stop() {
          stopCalls += 1
          return parseWorkflowTrace({
            format: 'opengrokbot.workflow', version: 1, title, steps: [
              { type: 'fill', target: { candidates: [{ label: 'API token' }] }, value: { kind: 'literal', text: 'should-never-persist' } },
              { type: 'click', target: { candidates: [{ role: { role: 'button', name: 'Save' } }] } },
            ],
          })
        },
        })
      },
    })
    const pool = createPool({ dataDir, makeComputer: async () => computer })
    const { app, isBusy } = createApp({ db, llm, pool, dataDir })

    try {
      expect((await app.request('/api/bots/missing/workflows')).status).toBe(404)
      expect((await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '   ' }),
      })).status).toBe(400)
      expect((await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Valid title', intent: 'Bearer abcdefghijkl' }),
      })).status).toBe(400)
      expect(startedIntent).toBeUndefined()

      const start = await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Submit a form', intent: 'Send the completed form' }),
      })
      expect(start.status).toBe(202)
      expect(await start.json()).toEqual({ ok: true, recording: true })
      expect(startedIntent).toBe('Send the completed form')
      expect(isBusy('researcher')).toBe(true)
      expect((await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Second recording' }),
      })).status).toBe(409)

      const computerState = await app.request('/api/bots/researcher/computer')
      expect(await computerState.json()).toMatchObject({ workflowRecording: true })

      const stop = await app.request('/api/bots/researcher/workflows/recording/stop', { method: 'POST' })
      expect(stop.status).toBe(200)
      const draft = await stop.json() as { id: string; trace: WorkflowTrace }
      expect(draft.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(draft.trace.steps).toHaveLength(2)
      expect(JSON.stringify(draft)).not.toContain('should-never-persist')
      expect(stopCalls).toBe(1)
      expect(isBusy('researcher')).toBe(false)

      expect(await (await app.request('/api/bots/researcher/workflows/recording/stop', { method: 'POST' })).json()).toEqual(draft)
      const pendingState = await app.request('/api/bots/researcher/computer')
      expect(await pendingState.json()).toMatchObject({ workflowRecording: false, workflowDraft: true })
      expect((await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Another one' }),
      })).status).toBe(409)

      const list = await app.request('/api/bots/researcher/workflows')
      expect(await list.json()).toEqual([])
      const reviewedTrace: WorkflowTrace = {
        ...draft.trace,
        steps: [{ type: 'fill', target: { candidates: [{ label: 'Customer email' }] }, value: { kind: 'placeholder', key: 'customerEmail' } }],
      }
      const invalidSave = await app.request('/api/bots/researcher/workflows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: draft.id, trace: { ...reviewedTrace, steps: [{ ...reviewedTrace.steps[0], frame: '../private' }] } }),
      })
      expect(invalidSave.status).toBe(400)

      const saveBody = JSON.stringify({ draftId: draft.id, trace: reviewedTrace })
      const save = await app.request('/api/bots/researcher/workflows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: saveBody,
      })
      expect(save.status).toBe(201)
      const saved = await save.json() as { id: string; trace: WorkflowTrace }
      expect(saved).toEqual({ id: draft.id, trace: reviewedTrace })
      expect(await (await app.request('/api/bots/researcher/workflows')).json()).toEqual([saved])
      const read = await app.request(`/api/bots/researcher/workflows/${saved.id}`)
      expect(await read.json()).toEqual(saved.trace)
      const duplicateSave = await app.request('/api/bots/researcher/workflows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: saveBody,
      })
      expect(duplicateSave.status).toBe(200)
      expect(await duplicateSave.json()).toEqual(saved)
      expect((await app.request('/api/bots/researcher/computer')).status).toBe(200)
      expect((await app.request('/api/bots/researcher/workflows/recording/stop', { method: 'POST' })).status).toBe(409)
    } finally {
      await pool.disposeAll()
      db.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('refuses a recording while busy and holds turns, cron, watch, and webhook runs until it stops', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ogb-workflow-gate-'))
    const db = openDb(':memory:')
    upsertBot(db, bot)
    const chat = vi.fn(async () => ({ content: 'ok', toolCalls: [], raw: { role: 'assistant' as const, content: 'ok' } }))
    const localLlm: LLM = { chat }
    const computer = createFakeComputer({
      startWorkflowRecording: async (title): Promise<WorkflowRecording> => ({
        async reattach() {},
        async stop() { return parseWorkflowTrace({ format: 'opengrokbot.workflow', version: 1, title, steps: [] }) },
      }),
    })
    const pool = createPool({ dataDir, makeComputer: async () => computer })
    const { app, isBusy, runRoutine } = createApp({ db, llm: localLlm, pool, dataDir })

    try {
      const start = await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Operator flow' }),
      })
      expect(start.status).toBe(202)

      const directTurn = await app.request('/api/threads/dm:researcher/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Please check this' }),
      })
      expect(directTurn.status).toBe(202)
      const cron = createRoutine(db, {
        botId: 'researcher', name: 'Daily digest', cron: '0 9 * * *', instructions: 'Summarise the inbox',
      })
      const watch = createRoutine(db, {
        botId: 'researcher', name: 'Status watch', cron: '', instructions: 'Check the status page', mode: 'watch',
      })
      const webhook = createRoutine(db, {
        botId: 'researcher', name: 'Issue triage', cron: '', instructions: 'Triage the issue', webhook: true,
      })
      const cronRun = runRoutine(cron, { force: true })
      const watchRun = runRoutine(watch, { force: true })
      const webhookResponse = await app.request(`/hooks/routines/${webhook.id}?key=${webhook.webhook_key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issue: 'New bug report' }),
      })
      expect(webhookResponse.status).toBe(202)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(chat).not.toHaveBeenCalled()
      expect(isBusy('researcher')).toBe(true)
      const heldMessages = await (await app.request('/api/threads/dm:researcher/messages')).json() as { kind: string }[]
      expect(heldMessages.some((message) => message.kind === 'webhook')).toBe(false)

      const stop = await app.request('/api/bots/researcher/workflows/recording/stop', { method: 'POST' })
      expect(stop.status).toBe(200)
      await Promise.all([cronRun, watchRun])
      await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(4))
      const resumedMessages = await (await app.request('/api/threads/dm:researcher/messages')).json() as { kind: string }[]
      expect(resumedMessages.filter((message) => message.kind === 'webhook')).toHaveLength(1)
      expect(isBusy('researcher')).toBe(false)
    } finally {
      await pool.disposeAll()
      db.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('releases the teammate and queued turns when stopping a recording fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ogb-workflow-stop-failure-'))
    const db = openDb(':memory:')
    upsertBot(db, bot)
    const chat = vi.fn(async () => ({ content: 'resumed', toolCalls: [], raw: { role: 'assistant' as const, content: 'resumed' } }))
    const localLlm: LLM = { chat }
    const computer = createFakeComputer({
      startWorkflowRecording: async (): Promise<WorkflowRecording> => ({
        async reattach() {},
        async stop() { throw new Error('trace exceeds the storage limit') },
      }),
    })
    const pool = createPool({ dataDir, makeComputer: async () => computer })
    const { app, isBusy } = createApp({ db, llm: localLlm, pool, dataDir })

    try {
      const start = await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Failure recovery' }),
      })
      expect(start.status).toBe(202)

      const stop = await app.request('/api/bots/researcher/workflows/recording/stop', { method: 'POST' })
      expect(stop.status).toBe(500)
      expect(isBusy('researcher')).toBe(false)

      const message = await app.request('/api/threads/dm:researcher/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Continue work' }),
      })
      expect(message.status).toBe(202)
      await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1))
    } finally {
      await pool.disposeAll()
      db.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('cancels a recording and releases the teammate lane', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ogb-workflow-cancel-'))
    const db = openDb(':memory:')
    upsertBot(db, bot)
    const stop = vi.fn(async () => parseWorkflowTrace({
      format: 'opengrokbot.workflow', version: 1, title: 'Discarded recording', steps: [],
    }))
    const computer = createFakeComputer({
      startWorkflowRecording: async (): Promise<WorkflowRecording> => ({
        async reattach() {}, stop,
      }),
    })
    const pool = createPool({ dataDir, makeComputer: async () => computer })
    const { app, isBusy } = createApp({ db, llm, pool, dataDir })

    try {
      expect((await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Discarded recording' }),
      })).status).toBe(202)

      const cancel = await app.request('/api/bots/researcher/workflows/recording', { method: 'DELETE' })
      expect(cancel.status).toBe(204)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(isBusy('researcher')).toBe(false)
      expect((await app.request('/api/bots/researcher/workflows/recording/stop', { method: 'POST' })).status).toBe(409)
    } finally {
      await pool.disposeAll()
      db.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('stops an overlong recording and leaves a marked incomplete draft', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ogb-workflow-time-limit-'))
    const db = openDb(':memory:')
    upsertBot(db, bot)
    const stop = vi.fn(async () => parseWorkflowTrace({
      format: 'opengrokbot.workflow', version: 1, title: 'Time-limited recording', steps: [],
    }))
    const computer = createFakeComputer({
      startWorkflowRecording: async (): Promise<WorkflowRecording> => ({
        async reattach() {}, stop,
      }),
    })
    const pool = createPool({ dataDir, makeComputer: async () => computer })
    const { app, isBusy } = createApp({ db, llm, pool, dataDir })

    vi.useFakeTimers()
    try {
      expect((await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Time-limited recording' }),
      })).status).toBe(202)

      await vi.advanceTimersByTimeAsync(WORKFLOW_RECORDING_MAX_MS)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(isBusy('researcher')).toBe(false)
      const draft = await (await app.request('/api/bots/researcher/workflows/recording/stop', { method: 'POST' })).json() as { trace: WorkflowTrace }
      expect(draft.trace.truncated).toBe(true)
    } finally {
      vi.useRealTimers()
      await pool.disposeAll()
      db.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('refuses to start recording while a turn is running', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ogb-workflow-busy-'))
    const db = openDb(':memory:')
    upsertBot(db, bot)
    let finishTurn: (() => void) | undefined
    let turnStarted!: () => void
    const started = new Promise<void>((resolve) => { turnStarted = resolve })
    const localLlm: LLM = {
      async chat() {
        turnStarted()
        await new Promise<void>((resolve) => { finishTurn = resolve })
        return { content: 'ok', toolCalls: [], raw: { role: 'assistant', content: 'ok' } }
      },
    }
    let recorderStarts = 0
    const computer = createFakeComputer({
      startWorkflowRecording: async (title): Promise<WorkflowRecording> => {
        recorderStarts += 1
        return { async reattach() {}, async stop() { return parseWorkflowTrace({ format: 'opengrokbot.workflow', version: 1, title, steps: [] }) } }
      },
    })
    const pool = createPool({ dataDir, makeComputer: async () => computer })
    const { app, isBusy } = createApp({ db, llm: localLlm, pool, dataDir })

    try {
      await app.request('/api/threads/dm:researcher/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Start work' }),
      })
      await started
      const response = await app.request('/api/bots/researcher/workflows/recording', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Operator flow' }),
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'the teammate is busy' })
      expect(recorderStarts).toBe(0)
    } finally {
      finishTurn?.()
      await vi.waitFor(() => expect(isBusy('researcher')).toBe(false))
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
      release?.({ reattach: async () => {}, stop: async () => parseWorkflowTrace({ format: 'opengrokbot.workflow', version: 1, title: 'First', steps: [] }) })
      expect((await first).status).toBe(202)
      const stop = await app.request('/api/bots/researcher/workflows/recording/stop', { method: 'POST' })
      expect(stop.status).toBe(200)
      const draft = await stop.json() as { id: string; trace: WorkflowTrace }
      expect((await app.request(`/api/bots/researcher/workflows/drafts/${draft.id}`, { method: 'DELETE' })).status).toBe(204)
      expect((await app.request(`/api/bots/researcher/workflows/${draft.id}`)).status).toBe(404)
    } finally {
      await pool.disposeAll()
      db.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
