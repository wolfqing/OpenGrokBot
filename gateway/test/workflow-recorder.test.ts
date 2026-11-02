import { describe, expect, it } from 'vitest'
import type { PageLike } from '../src/browser-page.js'
import { createWorkflowRecorder } from '../src/workflow-recorder.js'

type Binding = (source: unknown, event: unknown) => void | Promise<void>
type PageEvent = 'framenavigated' | 'close'
type Listener = (value?: unknown) => void

function fakePage() {
  let currentUrl = 'https://operator:login-secret@example.test/start?session=do-not-store#form'
  const bindings = new Map<string, Binding>()
  const listeners = new Map<PageEvent, Set<Listener>>([
    ['framenavigated', new Set()],
    ['close', new Set()],
  ])
  const scripts: string[] = []
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
    viewportSize: () => ({ width: 1280, height: 800 }),
  }
  return {
    page,
    bindings,
    listeners,
    scripts,
    setUrl(url: string) { currentUrl = url },
  }
}

describe('workflow recorder', () => {
  it('captures typed semantic actions on the current page and stops cleanly', async () => {
    const test = fakePage()
    const recorder = await createWorkflowRecorder(test.page, 'Sign in', 'Complete a secure sign-in')
    const binding = test.bindings.values().next().value
    expect(binding).toBeDefined()
    if (!binding) throw new Error('recorder did not expose its event binding')

    await binding({}, { type: 'click', target: { candidates: [{ role: { role: 'button', name: 'Continue' } }, { text: 'Continue' }] } })
    await binding({}, {
      type: 'fill', target: { candidates: [{ role: { role: 'textbox', name: 'Password' } }, { label: 'Password' }] },
      value: { kind: 'literal', text: 'do-not-store-this-password' },
    })
    await binding({}, {
      type: 'fill', target: { candidates: [{ label: 'Street address' }] }, value: { kind: 'literal', text: '14 Example Road' },
    })
    await binding({}, {
      type: 'select', target: { candidates: [{ label: 'One-time code' }] }, value: { kind: 'literal', text: '654321' },
    })

    test.setUrl('https://operator:second-secret@example.test/done?ticket=private-value#complete')
    for (const listener of test.listeners.get('framenavigated') ?? []) listener()
    const trace = await recorder.stop()
    expect(await recorder.stop()).toBe(trace)
    expect(trace.intent).toBe('Complete a secure sign-in')
    expect(trace.steps).toEqual([
      { type: 'navigate', url: 'https://example.test/start?session=' },
      { type: 'click', target: { candidates: [{ role: { role: 'button', name: 'Continue' } }, { text: 'Continue' }] } },
      { type: 'fill', target: { candidates: [{ role: { role: 'textbox', name: 'Password' } }, { label: 'Password' }] }, value: { kind: 'redacted', reason: 'sensitive-input' } },
      { type: 'fill', target: { candidates: [{ label: 'Street address' }] }, value: { kind: 'literal', text: '14 Example Road' } },
      { type: 'select', target: { candidates: [{ label: 'One-time code' }] }, value: { kind: 'redacted', reason: 'sensitive-input' } },
      { type: 'navigate', url: 'https://example.test/done?ticket=' },
    ])
    expect(JSON.stringify(trace)).not.toContain('secret')
    expect(JSON.stringify(trace)).not.toContain('private-value')
    expect(test.bindings.size).toBe(0)
    expect(test.listeners.get('framenavigated')?.size).toBe(0)
    expect(test.scripts.some((script) => script.includes('document.addEventListener'))).toBe(true)
    expect(test.scripts.some((script) => script.includes('state.cleanup'))).toBe(true)

    await binding({}, { type: 'click', target: { text: 'after stop' } })
    expect(trace.steps).toHaveLength(6)
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
    await firstBinding({}, { type: 'click', target: { candidates: [{ text: 'Before relaunch' }] } })

    await recorder.reattach(next.page)
    const nextBinding = next.bindings.values().next().value!
    await firstBinding({}, { type: 'click', target: { candidates: [{ text: 'Stale event' }] } })
    await nextBinding({}, { type: 'click', target: { candidates: [{ text: 'After relaunch' }] } })

    expect((await recorder.stop()).steps).toEqual([
      { type: 'navigate', url: 'https://example.test/start?session=' },
      { type: 'click', target: { candidates: [{ text: 'Before relaunch' }] } },
      { type: 'navigate', url: 'https://example.test/start?session=' },
      { type: 'click', target: { candidates: [{ text: 'After relaunch' }] } },
    ])
  })
})
