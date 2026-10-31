import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  listWorkflowTraces, parseWorkflowStep, parseWorkflowTrace, readWorkflowTrace, sanitizeWorkflowUrl,
  saveWorkflowTrace,
} from '../src/workflows.js'

describe('workflow trace schema', () => {
  it('redacts sensitive fields and credentials while retaining safe form data', () => {
    const trace = parseWorkflowTrace({
      format: 'opengrokbot.workflow',
      version: 1,
      title: '  Sign in  ',
      steps: [
        { type: 'navigate', url: 'https://operator:login-secret@example.test/start?session=do-not-store&view=compact#form' },
        { type: 'fill', target: { label: 'Password' }, value: { kind: 'literal', text: 'do-not-store-this-password' } },
        { type: 'select', target: { label: 'Verification code' }, value: { kind: 'literal', text: '123456' } },
        { type: 'fill', target: { label: 'Street address' }, value: { kind: 'literal', text: '14 Example Road' } },
      ],
    })

    expect(trace.title).toBe('Sign in')
    expect(trace.steps).toEqual([
      { type: 'navigate', url: 'https://example.test/start?session=&view=' },
      { type: 'fill', target: { label: 'Password' }, value: { kind: 'redacted', reason: 'sensitive-input' } },
      { type: 'select', target: { label: 'Verification code' }, value: { kind: 'redacted', reason: 'sensitive-input' } },
      { type: 'fill', target: { label: 'Street address' }, value: { kind: 'literal', text: '14 Example Road' } },
    ])
    const serialized = JSON.stringify(trace)
    expect(serialized).not.toContain('login-secret')
    expect(serialized).not.toContain('do-not-store')
    expect(serialized).not.toContain('123456')
  })

  it('drops secret-shaped literals and refuses unsupported or malformed trace data', () => {
    expect(parseWorkflowStep({
      type: 'fill', target: { placeholder: 'Search' },
      value: { kind: 'literal', text: 'ghp_123456789012345678901234567890123456' },
    })).toMatchObject({ value: { kind: 'redacted', reason: 'sensitive-input' } })
    expect(parseWorkflowStep({
      type: 'fill', target: { label: 'Card number' }, value: { kind: 'literal', text: '4111111111111111' },
    })).toMatchObject({ value: { kind: 'redacted', reason: 'sensitive-input' } })
    for (const label of ['user_secret', 'accessToken', 'api-key']) {
      expect(parseWorkflowStep({
        type: 'fill', target: { label }, value: { kind: 'literal', text: 'never-store-this-value' },
      })).toMatchObject({ value: { kind: 'redacted', reason: 'sensitive-input' } })
    }
    expect(() => sanitizeWorkflowUrl('javascript:alert(1)')).not.toThrow()
    expect(sanitizeWorkflowUrl('javascript:alert(1)')).toBeNull()
    expect(() => parseWorkflowTrace({ format: 'opengrokbot.workflow', version: 2, title: 'x', steps: [] }))
      .toThrow(/unsupported workflow trace format/)
    expect(() => parseWorkflowTrace({ format: 'opengrokbot.workflow', version: 1, title: 'x', steps: [{ type: 'click' }] }))
      .toThrow(/workflow locator/)
    expect(() => parseWorkflowStep({ type: 'navigate', url: 'file:///etc/passwd' })).toThrow(/workflow URL/)
  })

  it('drops secret-shaped locator text but retains a structural CSS fallback', () => {
    const step = parseWorkflowStep({
      type: 'click',
      target: { role: { role: 'button', name: 'Bearer do-not-store-this-secret' }, css: 'button:nth-of-type(1)' },
    })
    expect(step).toEqual({ type: 'click', target: { css: 'button:nth-of-type(1)' } })
    expect(JSON.stringify(step)).not.toContain('do-not-store-this-secret')

    const generatedPath = 'html:nth-of-type(1) > body:nth-of-type(1) > form:nth-of-type(1) > input:nth-of-type(6)'
    expect(parseWorkflowStep({ type: 'click', target: { css: generatedPath } }))
      .toEqual({ type: 'click', target: { css: generatedPath } })
  })

  it('stores traces atomically per teammate and validates IDs on read', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ogb-workflows-'))
    try {
      const saved = await saveWorkflowTrace(dataDir, 'researcher', parseWorkflowTrace({
        format: 'opengrokbot.workflow', version: 1, title: 'Contact form', steps: [
          { type: 'fill', target: { label: 'API token' }, value: { kind: 'literal', text: 'never-written-to-disk' } },
        ],
      }))
      const file = join(dataDir, 'bots', 'researcher', 'workflows', `${saved.id}.json`)
      const serialized = await readFile(file, 'utf8')
      expect(serialized).not.toContain('never-written-to-disk')
      expect(await readWorkflowTrace(dataDir, 'researcher', saved.id)).toEqual(saved.trace)
      expect(await listWorkflowTraces(dataDir, 'researcher')).toEqual([saved])
      await expect(readWorkflowTrace(dataDir, 'researcher', 'missing')).rejects.toThrow(/workflow id/)
      await expect(saveWorkflowTrace(dataDir, '../other', saved.trace)).rejects.toThrow(/bot id/)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
