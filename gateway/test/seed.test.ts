import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listBotsWithLastMessage, openDb, threadMembers } from '../src/db.js'
import { seedGroup, seedTeammates } from '../src/seed.js'

function makeTeammatesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teammates-'))
  mkdirSync(join(dir, 'researcher'))
  writeFileSync(join(dir, 'researcher', 'SOUL.md'), '# Scout\n\nYou are Scout.\n')
  mkdirSync(join(dir, 'no-soul')) // 无 SOUL.md，应跳过
  mkdirSync(join(dir, 'market-watch'))
  writeFileSync(join(dir, 'market-watch', 'SOUL.md'), 'no heading here\n')
  return dir
}

describe('seedTeammates', () => {
  it('seeds bots from SOUL.md folders, skips folders without SOUL.md', () => {
    const db = openDb(':memory:')
    const ids = seedTeammates(db, makeTeammatesDir())
    expect(ids.sort()).toEqual(['market-watch', 'researcher'])
    const rows = listBotsWithLastMessage(db)
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId['researcher']!.name).toBe('Scout') // 取一级标题
    expect(byId['market-watch']!.name).toBe('market-watch') // 无标题回退目录名
    expect(byId['researcher']!.thread_id).toBe('dm:researcher')
  })

  it('is idempotent', () => {
    const db = openDb(':memory:')
    const dir = makeTeammatesDir()
    seedTeammates(db, dir)
    seedTeammates(db, dir)
    expect(db.prepare('SELECT COUNT(*) c FROM bots').get()).toMatchObject({ c: 2 })
    expect(db.prepare('SELECT COUNT(*) c FROM threads').get()).toMatchObject({ c: 2 })
  })
})

describe('seedGroup', () => {
  it('creates the shared group with the seeded bots', () => {
    const db = openDb(':memory:')
    const ids = seedTeammates(db, makeTeammatesDir())
    seedGroup(db, { id: 'group:offsite-crew', title: 'Offsite crew', memberIds: ids })
    expect(threadMembers(db, 'group:offsite-crew').sort()).toEqual([...ids].sort())
  })

  it('is idempotent across restarts', () => {
    const db = openDb(':memory:')
    const dir = makeTeammatesDir()
    const ids = seedTeammates(db, dir)
    seedGroup(db, { id: 'group:offsite-crew', title: 'Offsite crew', memberIds: ids })
    seedGroup(db, { id: 'group:offsite-crew', title: 'Offsite crew', memberIds: ids })
    expect(threadMembers(db, 'group:offsite-crew')).toHaveLength(ids.length)
  })
})
