import { describe, expect, it } from 'vitest'
import { createFakeComputer } from '../src/computer.js'

describe('createFakeComputer', () => {
  it('records calls in order and returns sane defaults', async () => {
    const c = createFakeComputer()
    expect(await c.shell('echo hi')).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 })
    expect(await c.goto('https://example.com')).toEqual({ url: 'https://example.com', title: 'Example Domain' })
    expect(await c.extract()).toContain('Example')
    const shot = await c.screenshot()
    expect(shot.buffer.length).toBeGreaterThan(0)
    expect(shot).toMatchObject({ width: 1280, height: 800 })
    expect(c.calls).toEqual(['shell:echo hi', 'goto:https://example.com', 'extract', 'screenshot'])
  })

  it('honors overrides and pageText', async () => {
    const c = createFakeComputer({ pageText: 'custom page body', shell: async () => ({ stdout: 'x', stderr: 'boom', exitCode: 2 }) })
    expect(await c.shell('anything')).toEqual({ stdout: 'x', stderr: 'boom', exitCode: 2 })
    expect(await c.extract()).toBe('custom page body')
  })

  it('truncates extract at maxChars', async () => {
    const c = createFakeComputer({ pageText: 'abcdefghij' })
    expect(await c.extract(4)).toBe('abcd')
  })
})
