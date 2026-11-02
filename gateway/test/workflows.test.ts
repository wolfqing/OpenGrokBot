import { describe, expect, it } from 'vitest'
import { openDb, upsertBot } from '../src/db.js'
import {
  listWorkflowTraces, parseWorkflowStep, parseWorkflowTrace, readWorkflowTrace, sanitizeWorkflowUrl,
  saveWorkflowTrace,
} from '../src/workflows.js'

const dbWithBot = () => {
  const db = openDb(':memory:')
  upsertBot(db, { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' })
  return db
}

describe('workflow trace schema', () => {
  it('redacts sensitive fields and credentials while retaining safe form data', () => {
    const trace = parseWorkflowTrace({
      format: 'opengrokbot.workflow',
      version: 1,
      title: '  Sign in  ',
      steps: [
        { type: 'navigate', url: 'https://operator:login-secret@example.test/start?session=do-not-store&view=compact#form' },
        { type: 'fill', target: { candidates: [{ label: 'Password' }, { css: 'input:nth-of-type(1)' }] }, value: { kind: 'literal', text: 'do-not-store-this-password' } },
        { type: 'select', target: { candidates: [{ label: 'Verification code' }] }, value: { kind: 'literal', text: '123456' } },
        { type: 'fill', target: { candidates: [{ label: 'Street address' }] }, value: { kind: 'literal', text: '14 Example Road' } },
      ],
    })

    expect(trace.title).toBe('Sign in')
    expect(trace.steps).toEqual([
      { type: 'navigate', url: 'https://example.test/start?session=&view=' },
      { type: 'fill', target: { candidates: [{ label: 'Password' }, { css: 'input:nth-of-type(1)' }] }, value: { kind: 'redacted', reason: 'sensitive-input' } },
      { type: 'select', target: { candidates: [{ label: 'Verification code' }] }, value: { kind: 'redacted', reason: 'sensitive-input' } },
      { type: 'fill', target: { candidates: [{ label: 'Street address' }] }, value: { kind: 'literal', text: '14 Example Road' } },
    ])
    const serialized = JSON.stringify(trace)
    expect(serialized).not.toContain('login-secret')
    expect(serialized).not.toContain('do-not-store')
    expect(serialized).not.toContain('123456')
  })

  it('keeps locator strategies ordered, with exactly one strategy per candidate', () => {
    const step = parseWorkflowStep({
      type: 'click',
      target: { candidates: [
        { role: { role: 'button', name: 'Continue' } },
        { testId: 'continue-button' },
        { css: 'button:nth-of-type(1)' },
      ] },
    })
    expect(step).toEqual({ type: 'click', target: { candidates: [
      { role: { role: 'button', name: 'Continue' } }, { testId: 'continue-button' }, { css: 'button:nth-of-type(1)' },
    ] } })
  })

  it('supports optional intent and page/frame references on traces and steps', () => {
    const trace = parseWorkflowTrace({
      format: 'opengrokbot.workflow', version: 1, title: 'Create invoice', intent: 'Create a monthly invoice',
      steps: [{ type: 'click', intent: 'Open billing', page: 'main', frame: 'billing-form', target: { candidates: [{ text: 'Billing' }] } }],
    })
    expect(trace.intent).toBe('Create a monthly invoice')
    expect(trace.steps[0]).toMatchObject({ intent: 'Open billing', page: 'main', frame: 'billing-form' })
  })

  it('drops secret-shaped values and locator candidates but rejects malformed metadata', () => {
    expect(parseWorkflowStep({
      type: 'fill', target: { candidates: [{ placeholder: 'Search' }] },
      value: { kind: 'literal', text: 'ghp_123456789012345678901234567890123456' },
    })).toMatchObject({ value: { kind: 'redacted', reason: 'sensitive-input' } })
    expect(parseWorkflowStep({
      type: 'fill', target: { candidates: [{ label: 'Card number' }] }, value: { kind: 'literal', text: '4111111111111111' },
    })).toMatchObject({ value: { kind: 'redacted', reason: 'sensitive-input' } })
    for (const label of ['user_secret', 'accessToken', 'api-key']) {
      expect(parseWorkflowStep({
        type: 'fill', target: { candidates: [{ label }] }, value: { kind: 'literal', text: 'never-store-this-value' },
      })).toMatchObject({ value: { kind: 'redacted', reason: 'sensitive-input' } })
    }
    expect(() => sanitizeWorkflowUrl('javascript:alert(1)')).not.toThrow()
    expect(sanitizeWorkflowUrl('javascript:alert(1)')).toBeNull()
    expect(() => parseWorkflowTrace({ format: 'opengrokbot.workflow', version: 2, title: 'x', steps: [] }))
      .toThrow(/unsupported workflow trace format/)
    expect(() => parseWorkflowStep({ type: 'click', target: { candidates: [{ label: 'Continue', text: 'Continue' }] } }))
      .toThrow(/one strategy/)
    expect(() => parseWorkflowStep({ type: 'click', target: { candidates: [{ css: '#secret-value' }] } }))
      .toThrow(/structural fallback/)
    expect(() => parseWorkflowStep({ type: 'click', target: { candidates: [{ text: 'Bearer do-not-store-this-secret' }] } }))
      .toThrow(/ordered locator candidates/)
    expect(() => parseWorkflowTrace({ format: 'opengrokbot.workflow', version: 1, title: 'x', steps: [{ type: 'click' }] }))
      .toThrow(/workflow target/)
    expect(() => parseWorkflowTrace({ format: 'opengrokbot.workflow', version: 1, title: 'x', intent: 'Bearer abcdefghijkl', steps: [] }))
      .toThrow(/intent may not contain secrets/)
    expect(() => parseWorkflowStep({ type: 'navigate', url: 'file:///etc/passwd' })).toThrow(/workflow URL/)
    expect(() => parseWorkflowStep({ type: 'click', page: '../private', target: { candidates: [{ text: 'Continue' }] } }))
      .toThrow(/page reference/)
  })

  it('retains structural CSS fallbacks while dropping sensitive semantic locator candidates', () => {
    const step = parseWorkflowStep({
      type: 'click',
      target: { candidates: [
        { role: { role: 'button', name: 'Bearer do-not-store-this-secret' } },
        { css: 'button:nth-of-type(1)' },
      ] },
    })
    expect(step).toEqual({ type: 'click', target: { candidates: [{ css: 'button:nth-of-type(1)' }] } })
    expect(JSON.stringify(step)).not.toContain('do-not-store-this-secret')

    const generatedPath = 'html:nth-of-type(1) > body:nth-of-type(1) > form:nth-of-type(1) > input:nth-of-type(6)'
    expect(parseWorkflowStep({ type: 'click', target: { candidates: [{ css: generatedPath }] } }))
      .toEqual({ type: 'click', target: { candidates: [{ css: generatedPath }] } })
  })

  it('stores traces in SQLite per teammate and validates IDs on read', () => {
    const db = dbWithBot()
    try {
      const saved = saveWorkflowTrace(db, 'researcher', {
        format: 'opengrokbot.workflow', version: 1, title: 'Contact form', steps: [
          { type: 'fill', target: { candidates: [{ label: 'API token' }] }, value: { kind: 'literal', text: 'never-written-to-disk' } },
        ],
      })
      const raw = db.prepare('SELECT trace_json FROM workflows WHERE id = ?').get(saved.id) as { trace_json: string }
      expect(raw.trace_json).not.toContain('never-written-to-disk')
      expect(readWorkflowTrace(db, 'researcher', saved.id)).toEqual(saved.trace)
      expect(listWorkflowTraces(db, 'researcher')).toEqual([saved])
      expect(readWorkflowTrace(db, 'researcher', '00000000-0000-4000-8000-000000000000')).toBeNull()
      expect(() => readWorkflowTrace(db, 'researcher', 'not-a-uuid')).toThrow(/workflow id/)
      expect(() => saveWorkflowTrace(db, '../other', saved.trace)).toThrow(/bot id/)
    } finally {
      db.close()
    }
  })
})
