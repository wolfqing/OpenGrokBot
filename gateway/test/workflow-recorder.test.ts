import { describe, expect, it } from 'vitest'
import type { PageLike } from '../src/browser-page.js'
import { createWorkflowRecorder } from '../src/workflow-recorder.js'

type Binding = (source: unknown, event: unknown) => void | Promise<void>
type PageEvent = 'framenavigated' | 'close' | 'popup'
type Listener = (value?: unknown) => void
type PageHarness = ReturnType<typeof fakePage>

async function fire(test: PageHarness, binding: Binding, event: Record<string, unknown>, frame: unknown = test.mainFrame) {
  const capability = test.scripts[0]?.match(/const capability = "([a-f0-9]+)";/)?.[1]
  if (!capability) throw new Error('recorder did not install its event capability')
  await binding({ frame }, { ...event, isTrusted: true, __proof: capability })
}

function fakePage() {
  let currentUrl = 'https://operator:login-secret@example.test/start?session=do-not-store#form'
  const bindings = new Map<string, Binding>()
  const listeners = new Map<PageEvent, Set<Listener>>([
    ['framenavigated', new Set()],
    ['close', new Set()],
    ['popup', new Set()],
  ])
  const scripts: string[] = []
  const mainFrame = { name: 'main' }
  const page: PageLike = {
    async goto() {},
    async title() { return 'Example' },
    url: () => currentUrl,
    async innerText() { return '' },
    async screenshot() { return Buffer.alloc(0) },
    async click() {},
    async evaluate(script) { scripts.push(script); return undefined },
    async exposeBinding(name, callback) {
      bindings.set(name, callback)
      return { async dispose() { bindings.delete(name) } }
    },
    on(event, listener) { listeners.get(event)?.add(listener) },
    off(event, listener) { listeners.get(event)?.delete(listener) },
    mainFrame: () => mainFrame,
    viewportSize: () => ({ width: 1280, height: 800 }),
  }
  return {
    page,
    bindings,
    listeners,
    scripts,
    mainFrame,
    subFrame: { name: 'child' },
    setUrl(url: string) { currentUrl = url },
  }
}

describe('workflow recorder', () => {
  it('rejects forged binding events and events from a subframe', async () => {
    const test = fakePage()
    const recorder = await createWorkflowRecorder(test.page, 'Untrusted page')
    const binding = test.bindings.values().next().value
    expect(binding).toBeDefined()
    if (!binding) throw new Error('recorder did not expose its event binding')

    await binding({ frame: test.mainFrame }, {
      type: 'navigate', url: 'https://evil.example/landing', intent: 'INJECTED-INTENT',
    })
    await binding({ frame: test.mainFrame }, {
      type: 'click', isTrusted: true, target: { candidates: [{ text: 'forged click' }] },
    })
    await fire(test, binding, {
      type: 'click', target: { candidates: [{ text: 'trusted click' }] },
      intent: 'INJECTED-INTENT', expect: { url: 'https://evil.example/' }, page: 'evil', frame: 'evil',
    })
    await fire(test, binding, { type: 'click', target: { candidates: [{ text: 'subframe click' }] } }, test.subFrame)

    const trace = await recorder.stop()
    expect(trace.steps).toEqual([
      { type: 'navigate', url: 'https://example.test/start?session=' },
      { type: 'click', target: { candidates: [{ text: 'trusted click' }] } },
    ])
    expect(JSON.stringify(trace)).not.toContain('INJECTED-INTENT')
  })

  it('truncates an oversized recording and marks the saved trace incomplete', async () => {
    const test = fakePage()
    const recorder = await createWorkflowRecorder(test.page, 'Large recording')
    const binding = test.bindings.values().next().value
    expect(binding).toBeDefined()
    if (!binding) throw new Error('recorder did not expose its event binding')
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      label: `Field ${index} ${'a'.repeat(248)}`,
    }))
    for (let index = 0; index < 1_000; index++) {
      await fire(test, binding, {
        type: 'fill', target: { candidates }, value: { kind: 'literal', text: '\n'.repeat(2_000) },
      })
    }

    const trace = await recorder.stop()
    expect(trace.truncated).toBe(true)
    expect(trace.steps.length).toBeLessThan(1_000)
  })

  it('captures typed semantic actions on the current page and stops cleanly', async () => {
    const test = fakePage()
    const recorder = await createWorkflowRecorder(test.page, 'Sign in', 'Complete a secure sign-in')
    const binding = test.bindings.values().next().value
    expect(binding).toBeDefined()
    if (!binding) throw new Error('recorder did not expose its event binding')

    await fire(test, binding, { type: 'click', target: { candidates: [{ role: { role: 'button', name: 'Continue' } }, { text: 'Continue' }] } })
    await fire(test, binding, {
      type: 'fill', target: { candidates: [{ role: { role: 'textbox', name: 'Password' } }, { label: 'Password' }] },
      value: { kind: 'literal', text: 'do-not-store-this-password' },
    })
    await fire(test, binding, {
      type: 'fill', target: { candidates: [{ label: 'Street address' }] }, value: { kind: 'literal', text: '14 Example Road' },
    })
    await fire(test, binding, {
      type: 'select', target: { candidates: [{ label: 'One-time code' }] }, value: { kind: 'literal', text: '654321' },
    })

    test.setUrl('https://operator:second-secret@example.test/done?ticket=private-value#complete')
    for (const listener of test.listeners.get('framenavigated') ?? []) listener(test.mainFrame)
    const trace = await recorder.stop()
    expect(await recorder.stop()).toBe(trace)
    expect(trace.intent).toBe('Complete a secure sign-in')
    expect(trace.steps).toEqual([
      { type: 'navigate', url: 'https://example.test/start?session=' },
      { type: 'click', target: { candidates: [{ role: { role: 'button', name: 'Continue' } }, { text: 'Continue' }] } },
      { type: 'fill', target: { candidates: [{ role: { role: 'textbox', name: 'Password' } }, { label: 'Password' }] }, value: { kind: 'redacted', reason: 'sensitive-input' } },
      { type: 'fill', target: { candidates: [{ label: 'Street address' }] }, value: { kind: 'literal', text: '14 Example Road' } },
      { type: 'select', target: { candidates: [{ label: 'One-time code' }] }, value: { kind: 'redacted', reason: 'sensitive-input' }, expect: { url: 'https://example.test/done?ticket=' } },
    ])
    expect(JSON.stringify(trace)).not.toContain('secret')
    expect(JSON.stringify(trace)).not.toContain('private-value')
    expect(test.bindings.size).toBe(0)
    expect(test.listeners.get('framenavigated')?.size).toBe(0)
    expect(test.scripts.some((script) => script.includes('document.addEventListener'))).toBe(true)
    expect(test.scripts.some((script) => script.includes('state.cleanup'))).toBe(true)

    await fire(test, binding, { type: 'click', target: { text: 'after stop' } })
    expect(trace.steps).toHaveLength(5)
  })

  it('ignores subframe navigation and marks popup pages as unrecorded', async () => {
    const test = fakePage()
    const recorder = await createWorkflowRecorder(test.page, 'External flow')
    for (const listener of test.listeners.get('framenavigated') ?? []) listener(test.subFrame)
    for (const listener of test.listeners.get('popup') ?? []) listener({ url: () => 'https://popup.example.test/' })

    expect((await recorder.stop()).steps).toEqual([
      { type: 'navigate', url: 'https://example.test/start?session=' },
      { type: 'unrecorded-popup' },
    ])
  })

  it('marks the trace incomplete when the attached browser page closes unexpectedly', async () => {
    const test = fakePage()
    const recorder = await createWorkflowRecorder(test.page, 'Page closed')
    for (const listener of test.listeners.get('close') ?? []) listener()

    const trace = await recorder.stop()
    expect(trace.truncated).toBe(true)
  })

  it('fails clearly when the computer page lacks Playwright event hooks', async () => {
    const page: PageLike = {
      async goto() {}, async title() { return '' }, url: () => 'about:blank', async innerText() { return '' },
      async screenshot() { return Buffer.alloc(0) }, async click() {}, viewportSize: () => null,
    }
    await expect(createWorkflowRecorder(page, 'A workflow')).rejects.toThrow(/cannot record workflow events/)
  })

  it('reattaches to a replacement page and ignores events from the old page', async () => {
    const first = fakePage()
    const next = fakePage()
    const recorder = await createWorkflowRecorder(first.page, 'Reattach')
    const firstBinding = first.bindings.values().next().value!
    await fire(first, firstBinding, { type: 'click', target: { candidates: [{ text: 'Before relaunch' }] } })

    await recorder.reattach(next.page)
    const nextBinding = next.bindings.values().next().value!
    await fire(first, firstBinding, { type: 'click', target: { candidates: [{ text: 'Stale event' }] } })
    await fire(next, nextBinding, { type: 'click', target: { candidates: [{ text: 'After relaunch' }] } })

    expect((await recorder.stop()).steps).toEqual([
      { type: 'navigate', url: 'https://example.test/start?session=' },
      { type: 'click', target: { candidates: [{ text: 'Before relaunch' }] } },
      { type: 'navigate', url: 'https://example.test/start?session=' },
      { type: 'click', target: { candidates: [{ text: 'After relaunch' }] } },
    ])
  })
})
