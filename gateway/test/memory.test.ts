import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendMemoryRule, memoryPath, readMemory } from '../src/memory.js'

const newDir = () => mkdtempSync(join(tmpdir(), 'ogb-mem-'))

describe('memoryPath', () => {
  it('lives in the bot workspace so the bot can read it too', () => {
    expect(memoryPath('/data', 'researcher')).toBe('/data/workspaces/researcher/MEMORY.md')
  })
})

describe('appendMemoryRule', () => {
  it('creates the file with a heading and returns the diff', async () => {
    const dir = newDir()
    const first = await appendMemoryRule(dir, 'inbox-keeper', 'quiet-account sends wait for your read')
    expect(first).toEqual({
      rule: 'quiet-account sends wait for your read',
      diff: '+ - quiet-account sends wait for your read',
      total: 1,
    })
    expect(readFileSync(memoryPath(dir, 'inbox-keeper'), 'utf8'))
      .toBe('# MEMORY\n\n- quiet-account sends wait for your read\n')
  })

  it('appends further rules and counts them', async () => {
    const dir = newDir()
    await appendMemoryRule(dir, 'inbox-keeper', 'first rule')
    const second = await appendMemoryRule(dir, 'inbox-keeper', 'second rule')
    expect(second.total).toBe(2)
    expect(await readMemory(dir, 'inbox-keeper')).toContain('- first rule\n- second rule')
  })

  it('is a no-op for a rule already on file', async () => {
    const dir = newDir()
    await appendMemoryRule(dir, 'inbox-keeper', 'same rule')
    const again = await appendMemoryRule(dir, 'inbox-keeper', '  same rule  ')
    expect(again).toEqual({ rule: 'same rule', diff: '', total: 1 })
    expect(readFileSync(memoryPath(dir, 'inbox-keeper'), 'utf8').match(/same rule/g)).toHaveLength(1)
  })
})

describe('readMemory', () => {
  it('returns empty string when the bot has no memory yet', async () => {
    expect(await readMemory(newDir(), 'nobody')).toBe('')
  })
})
