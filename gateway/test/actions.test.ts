import { describe, expect, it } from 'vitest'
import { listActions, pruneActions, recordAction } from '../src/actions.js'
import { openDb } from '../src/db.js'

describe('action log', () => {
  it('lists the newest first, per teammate, with ok as a boolean', () => {
    const db = openDb(':memory:')
    recordAction(db, { botId: 'scout', threadId: 'dm:scout', trigger: 'you', tool: 'shell', summary: 'ls', ok: true, ms: 12, at: 1 })
    recordAction(db, { botId: 'scout', threadId: 'dm:scout', trigger: 'watch', tool: 'browser_goto', summary: 'x.ai', ok: false, ms: 900, at: 2 })
    recordAction(db, { botId: 'ticker', threadId: 'dm:ticker', trigger: 'you', tool: 'approval', summary: 'approved by you', at: 3 })
    expect(listActions(db, 'scout').map((a) => [a.tool, a.ok, a.trigger])).toEqual([['browser_goto', false, 'watch'], ['shell', true, 'you']])
    expect(listActions(db, 'ticker')[0]).toMatchObject({ ok: null, ms: null })
  })

  it('keeps summaries to one short line', () => {
    const db = openDb(':memory:')
    recordAction(db, { botId: 'scout', threadId: 'dm:scout', trigger: 'you', tool: 'shell', summary: `a\n  b ${'x'.repeat(400)}`, at: 1 })
    const [entry] = listActions(db, 'scout')
    expect(entry!.summary.startsWith('a b x')).toBe(true)
    expect(entry!.summary).toHaveLength(200)
  })

  it('drops entries older than the cutoff', () => {
    const db = openDb(':memory:')
    for (const at of [1, 2, 3]) recordAction(db, { botId: 'scout', threadId: 'dm:scout', trigger: 'you', tool: 't', summary: '', at })
    expect(pruneActions(db, 3)).toBe(2)
    expect(listActions(db, 'scout')).toHaveLength(1)
  })
})
