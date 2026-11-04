import { describe, expect, it } from 'vitest'
import type { CdpSessionLike, PageLike } from '../src/browser-page.js'
import { createWorkflowRecorder } from '../src/workflow-recorder.js'

type CdpListener = (value: unknown) => void
type PageEvent = 'framenavigated' | 'close' | 'popup'
type PageListener = (value?: unknown) => void
type PageHarness = ReturnType<typeof fakePage>

async function fire(test: PageHarness, event: Record<string, unknown>, contextId = test.contextId) {
  const capability = test.scripts[0]?.match(/const capability = "([a-f0-9]+)";/)?.[1]
  if (!capability) throw new Error('recorder did not install its event capability')
  test.emit('Runtime.bindingCalled', {
    name: test.bindingName,
    executionContextId: contextId,
    payload: JSON.stringify({ ...event, isTrusted: true, __proof: capability }),
  })
}

let nextFrame = 0

function fakePage() {
  let currentUrl = 'https://operator:login-secret@example.test/start?session=do-not-store#form'
  let documentVersion = 0
  let nextContextId = 0
  let bindingName = ''
  const frameId = `main-${++nextFrame}`
  const bindings = new Set<string>()
  const scripts: string[] = []
  const cdpListeners = new Map<string, Set<CdpListener>>()
  const pageListeners = new Map<PageEvent, Set<PageListener>>([
    ['framenavigated', new Set()], ['close', new Set()], ['popup', new Set()],
  ])

  const session: CdpSessionLike = {
    on(event, listener) {
      const listeners = cdpListeners.get(event) ?? new Set<CdpListener>()
      listeners.add(listener)
      cdpListeners.set(event, listeners)
    },
    off(event, listener) { cdpListeners.get(event)?.delete(listener) },
    async send(method, params) {
      if (method === 'Runtime.addBinding' && typeof params?.name === 'string') {
        bindingName = params.name
        bindings.add(bindingName)
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: frameId, url: currentUrl, loaderId: `document-${documentVersion}` } } }
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: ++nextContextId }
      if (method === 'Runtime.evaluate' && typeof params?.expression === 'string') scripts.push(params.expression)
      if (method === 'Runtime.removeBinding' && typeof params?.name === 'string') bindings.delete(params.name)
      return {}
    },
    async detach() {},
  }

  const page: PageLike = {
    async goto(url) {
      currentUrl = url
      documentVersion += 1
      for (const listener of cdpListeners.get('Page.frameNavigated') ?? []) {
        listener({ frame: { id: frameId, url, loaderId: `document-${documentVersion}` } })
      }
    },
    async title() { return 'Example' },
    url: () => currentUrl,
    async innerText() { return '' },
    async screenshot() { return Buffer.alloc(0) },
    async click() {},
    context: () => ({ newCDPSession: async () => session }),
    on(event, listener) { pageListeners.get(event)?.add(listener) },
    off(event, listener) { pageListeners.get(event)?.delete(listener) },
    viewportSize: () => ({ width: 1280, height: 800 }),
  }

  return {
    page,
    bindings,
    scripts,
    cdpListeners,
    pageListeners,
    frameId,
    get bindingName() { return bindingName },
    get contextId() { return nextContextId },
    emit(event: string, value: unknown) {
      for (const listener of cdpListeners.get(event) ?? []) listener(value)
    },
    firePopup() {
      for (const listener of pageListeners.get('popup') ?? []) listener({})
    },
    close() {
      for (const listener of pageListeners.get('close') ?? []) listener()
    },
    setUrl(url: string) { currentUrl = url },
    navigateSameDocument(url: string) {
      currentUrl = url
      this.emit('Page.navigatedWithinDocument', { frameId, url })
    },
    navigateDocument(url: string) {
      currentUrl = url
      documentVersion += 1
      this.emit('Page.frameNavigated', {
        frame: { id: frameId, url, loaderId: `document-${documentVersion}` },
      })
    },
  }
}

describe('workflow recorder', () => {
  it('rejects forged binding payloads and events from unregistered execution contexts', async () => {
    const test = fakePage()
    const recorder = await createWorkflowRecorder(test.page, 'Untrusted page')

    test.emit('Runtime.bindingCalled', {
      name: test.bindingName, executionContextId: test.contextId,
      payload: JSON.stringify({ type: 'navigate', url: 'https://evil.example/landing', intent: 'INJECTED-INTENT' }),
    })
    test.emit('Runtime.bindingCalled', {
      name: test.bindingName, executionContextId: test.contextId,
      payload: JSON.stringify({ type: 'click', isTrusted: true, target: { candidates: [{ text: 'forged click' }] } }),
    })
    await fire(test, {
      type: 'click', target: { candidates: [{ text: 'trusted click' }] },
      intent: 'INJECTED-INTENT', expect: { url: 'https://evil.example/' }, page: 'evil', frame: 'evil',
    })
    await fire(test, { type: 'click', target: { candidates: [{ text: 'unregistered context' }] } }, 999_999)

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
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      label: `Field ${index} ${'a'.repeat(248)}`,
    }))
    for (let index = 0; index < 1_000; index++) {
      await fire(test, {
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

    await fire(test, { type: 'click', target: { candidates: [{ role: { role: 'button', name: 'Continue' } }, { text: 'Continue' }] } })
    await fire(test, {
      type: 'fill', target: { candidates: [{ role: { role: 'textbox', name: 'Password' } }, { label: 'Password' }] },
      value: { kind: 'literal', text: 'do-not-store-this-password' },
    })
    await fire(test, {
      type: 'fill', target: { candidates: [{ label: 'Street address' }] }, value: { kind: 'literal', text: '14 Example Road' },
    })
    await fire(test, {
      type: 'select', target: { candidates: [{ label: 'One-time code' }] }, value: { kind: 'literal', text: '654321' },
    })

    test.navigateSameDocument('https://operator:second-secret@example.test/done?ticket=private-value#complete')
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
    expect(test.cdpListeners.get('Page.frameNavigated')?.size).toBe(0)
    expect(test.scripts.some((script) => script.includes('document.addEventListener'))).toBe(true)
    expect(test.scripts.some((script) => script.includes('state.cleanup'))).toBe(true)

    await fire(test, { type: 'click', target: { candidates: [{ text: 'after stop' }] } })
    expect(trace.steps).toHaveLength(5)
  })

  it('ignores subframe navigation and marks popup pages as unrecorded', async () => {
    const test = fakePage()
    const recorder = await createWorkflowRecorder(test.page, 'External flow')
    test.emit('Page.frameNavigated', {
      frame: { id: 'child', parentId: test.frameId, url: 'https://child.example.test/', loaderId: 'child-1' },
    })
    test.firePopup()

    expect((await recorder.stop()).steps).toEqual([
      { type: 'navigate', url: 'https://example.test/start?session=' },
      { type: 'unrecorded-popup' },
    ])
  })

  it('marks the trace incomplete when the attached browser page closes unexpectedly', async () => {
    const test = fakePage()
    const recorder = await createWorkflowRecorder(test.page, 'Page closed')
    test.close()

    const trace = await recorder.stop()
    expect(trace.truncated).toBe(true)
  })

  it('fails clearly when the computer page lacks Chromium DevTools hooks', async () => {
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
    await fire(first, { type: 'click', target: { candidates: [{ text: 'Before relaunch' }] } })

    await recorder.reattach(next.page)
    await fire(first, { type: 'click', target: { candidates: [{ text: 'Stale event' }] } })
    await fire(next, { type: 'click', target: { candidates: [{ text: 'After relaunch' }] } })

    expect((await recorder.stop()).steps).toEqual([
      { type: 'navigate', url: 'https://example.test/start?session=' },
      { type: 'click', target: { candidates: [{ text: 'Before relaunch' }] } },
      { type: 'navigate', url: 'https://example.test/start?session=' },
      { type: 'click', target: { candidates: [{ text: 'After relaunch' }] } },
    ])
  })
})
