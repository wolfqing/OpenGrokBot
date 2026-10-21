import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  SCHEMA_VERSION, ensureDmThread, ensureGroupThread, insertMessage, listBotsWithLastMessage, listConversations,
  listMessages, openDb, runMigrations, schemaVersion, threadMembers, updateMessagePayload, upsertBot, type Migration,
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

describe('schema migrations', () => {
  const tempDb = () => join(mkdtempSync(join(tmpdir(), 'ogb-db-')), 'test.db')

  it('stamps a fresh database with the current schema version', () => {
    const db = openDb(':memory:')
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)
  })

  it('adopts a v0.2 database (tables present, no version) without touching its rows', () => {
    const path = tempDb()
    // v0.2.x 建库的方式：直接建表，从不写版本号
    const legacy = new Database(path)
    legacy.exec(`CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
      emoji TEXT NOT NULL DEFAULT '🤖', soul_path TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`)
    legacy.prepare('INSERT INTO bots (id, name, created_at) VALUES (?, ?, ?)').run('researcher', 'Scout', 1)
    legacy.close()

    const migrated: [number, number][] = []
    const db = openDb(path, { onMigrate: (from, to) => migrated.push([from, to]) })
    expect(migrated).toEqual([[0, SCHEMA_VERSION]])
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(db.prepare('SELECT name FROM bots WHERE id = ?').get('researcher')).toMatchObject({ name: 'Scout' })
    // 基线里的其余表也补齐了
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'routines'`).get()).toBeTruthy()
    db.close()
  })

  it('is a no-op on a database that is already current', () => {
    const path = tempDb()
    openDb(path).close()
    const migrated: [number, number][] = []
    const db = openDb(path, { onMigrate: (from, to) => migrated.push([from, to]) })
    expect(migrated).toEqual([])
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('runs only the steps a database has not seen, each with its version bump', () => {
    const db = openDb(':memory:')
    upsertBot(db, scout)
    const addNickname: Migration = (d) => d.exec('ALTER TABLE bots ADD COLUMN nickname TEXT')
    const steps: Migration[] = [() => { throw new Error('baseline must not run twice') }, addNickname]
    expect(runMigrations(db, steps)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION + 1 })
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION + 1)
    expect(db.prepare('SELECT nickname FROM bots WHERE id = ?').get('researcher')).toMatchObject({ nickname: null })
  })

  it('leaves the version untouched when a step fails', () => {
    const db = openDb(':memory:')
    const broken: Migration[] = [() => {}, (d) => d.exec('THIS IS NOT SQL')]
    expect(() => runMigrations(db, broken)).toThrow()
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)
  })

  it('refuses a database written by a newer gateway', () => {
    const path = tempDb()
    const future = new Database(path)
    future.pragma(`user_version = ${SCHEMA_VERSION + 7}`)
    future.close()
    expect(() => openDb(path)).toThrow(/newer OpenGrokBot/)
  })
})
