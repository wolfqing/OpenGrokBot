import { describe, expect, it } from 'vitest'
import {
  ensureDmThread, insertMessage, listBotsWithLastMessage, listMessages, openDb, upsertBot,
} from '../src/db.js'

const scout = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', soul_path: '' }

describe('db', () => {
  it('roundtrips messages with JSON payload in order', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const tid = ensureDmThread(db, 'researcher')
    expect(tid).toBe('dm:researcher')
    insertMessage(db, { threadId: tid, sender: 'user', kind: 'text', content: 'hi' })
    const report = insertMessage(db, {
      threadId: tid, sender: 'researcher', kind: 'report',
      payload: { lines: [{ system: 'Web', result: 'scanned', count: '3 pages' }] },
    })
    expect(report.id).toBeGreaterThan(0)
    const all = listMessages(db, tid)
    expect(all.map((m) => m.kind)).toEqual(['text', 'report'])
    expect((all[1]!.payload as { lines: { system: string }[] }).lines[0]!.system).toBe('Web')
  })

  it('ensureDmThread is idempotent', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    ensureDmThread(db, 'researcher')
    ensureDmThread(db, 'researcher')
    expect(db.prepare('SELECT COUNT(*) c FROM threads').get()).toMatchObject({ c: 1 })
  })

  it('lists bots with last message for sidebar', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    upsertBot(db, { id: 'market-watch', name: 'Ticker', role: 'markets', emoji: '📈', soul_path: '' })
    const tid = ensureDmThread(db, 'researcher')
    ensureDmThread(db, 'market-watch')
    insertMessage(db, { threadId: tid, sender: 'user', kind: 'text', content: 'first' })
    insertMessage(db, { threadId: tid, sender: 'researcher', kind: 'text', content: 'Done.' })
    const rows = listBotsWithLastMessage(db)
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId['researcher']!.last_message!.content).toBe('Done.')
    expect(byId['market-watch']!.last_message).toBeNull()
    expect(byId['researcher']!.thread_id).toBe('dm:researcher')
  })

  it('upsertBot updates in place', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    upsertBot(db, { ...scout, name: 'Scout II' })
    expect(db.prepare('SELECT name FROM bots WHERE id = ?').get('researcher')).toMatchObject({ name: 'Scout II' })
  })
})
