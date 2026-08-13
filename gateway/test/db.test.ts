import { describe, expect, it } from 'vitest'
import {
  ensureDmThread, ensureGroupThread, insertMessage, listBotsWithLastMessage, listConversations, listMessages,
  openDb, threadMembers, updateMessagePayload, upsertBot,
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

describe('updateMessagePayload', () => {
  it('rewrites a stored payload in place', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const tid = ensureDmThread(db, 'researcher')
    const m = insertMessage(db, {
      threadId: tid, sender: 'researcher', kind: 'approval_request',
      payload: { approvalId: 1, action: 'send 4 drafts', status: 'pending' },
    })
    updateMessagePayload(db, m.id, { approvalId: 1, action: 'send 4 drafts', status: 'approved' })
    const stored = listMessages(db, tid)[0]!
    expect((stored.payload as { status: string }).status).toBe('approved')
    expect(stored.kind).toBe('approval_request')
  })
})

describe('schema', () => {
  it('provides approvals and routines tables', () => {
    const db = openDb(':memory:')
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['bots', 'threads', 'messages', 'approvals', 'routines']))
  })
})

describe('group threads', () => {
  it('creates a group with members and is idempotent', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    upsertBot(db, { id: 'market-watch', name: 'Ticker', role: 'markets', emoji: '📈', soul_path: '' })
    const id = ensureGroupThread(db, 'group:offsite-crew', 'Offsite crew', ['researcher', 'market-watch'])
    expect(id).toBe('group:offsite-crew')
    expect(threadMembers(db, id)).toEqual(['researcher', 'market-watch'])
    ensureGroupThread(db, 'group:offsite-crew', 'Offsite crew', ['researcher', 'market-watch'])
    expect(threadMembers(db, id)).toEqual(['researcher', 'market-watch'])
  })

  it('adds newly seeded members to an existing group', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    ensureGroupThread(db, 'group:offsite-crew', 'Offsite crew', ['researcher'])
    upsertBot(db, { id: 'chief', name: 'Chief', role: 'staff', emoji: '🎖️', soul_path: '' })
    ensureGroupThread(db, 'group:offsite-crew', 'Offsite crew', ['researcher', 'chief'])
    expect(threadMembers(db, 'group:offsite-crew')).toEqual(['researcher', 'chief'])
  })
})

describe('listConversations', () => {
  it('lists dms by bot name then groups by title, each with its last message', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    upsertBot(db, { id: 'market-watch', name: 'Ticker', role: 'markets', emoji: '📈', soul_path: '' })
    ensureDmThread(db, 'researcher')
    ensureDmThread(db, 'market-watch')
    ensureGroupThread(db, 'group:offsite-crew', 'Offsite crew', ['researcher', 'market-watch'])
    insertMessage(db, { threadId: 'group:offsite-crew', sender: 'researcher', kind: 'text', content: 'on it' })

    const rows = listConversations(db)
    expect(rows.map((r) => r.id)).toEqual(['dm:researcher', 'dm:market-watch', 'group:offsite-crew'])
    expect(rows[0]).toMatchObject({ kind: 'dm', title: 'Scout', emoji: '🔎' })
    const group = rows[2]!
    expect(group).toMatchObject({ kind: 'group', title: 'Offsite crew', emoji: '👥' })
    expect(group.members).toEqual(['researcher', 'market-watch'])
    expect(group.subtitle).toBe('Scout, Ticker')
    expect(group.last_message!.content).toBe('on it')
  })
})
