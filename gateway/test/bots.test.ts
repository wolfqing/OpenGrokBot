import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBot, slugifyBotId, soulFromJob } from '../src/bots.js'
import { ensureGroupThread, listConversations, openDb, threadMembers, upsertBot } from '../src/db.js'

const newDir = () => mkdtempSync(join(tmpdir(), 'ogb-bots-'))

describe('slugifyBotId', () => {
  it('makes a filesystem and url safe id', () => {
    expect(slugifyBotId('Talent Scout')).toBe('talent-scout')
    expect(slugifyBotId('  Expense   Manager! ')).toBe('expense-manager')
    expect(slugifyBotId('Ops')).toBe('ops')
    expect(slugifyBotId('   ')).toBe('')
  })
})

describe('soulFromJob', () => {
  it('writes a soul that names the teammate and its job', () => {
    const soul = soulFromJob('Talent Scout', 'Finds and screens candidates')
    expect(soul).toContain('# Talent Scout')
    expect(soul).toContain('Finds and screens candidates')
  })
})

describe('createBot', () => {
  it('creates the workspace soul, the bot row, its thread and group seat', async () => {
    const db = openDb(':memory:')
    const dataDir = newDir()
    upsertBot(db, { id: 'chief', name: 'Chief', role: 'staff', emoji: '🎖️', soul_path: '' })
    ensureGroupThread(db, 'group:offsite-crew', 'Offsite crew', ['chief'])

    const bot = await createBot(db, {
      dataDir, name: 'Talent Scout', role: 'Finds and screens candidates', groupId: 'group:offsite-crew',
    })

    expect(bot.id).toBe('talent-scout')
    expect(bot.soul_path).toBe(join(dataDir, 'teammates', 'talent-scout', 'SOUL.md'))
    expect(existsSync(bot.soul_path)).toBe(true)
    expect(readFileSync(bot.soul_path, 'utf8')).toContain('# Talent Scout')

    const conversations = listConversations(db)
    expect(conversations.find((c) => c.id === 'dm:talent-scout')).toMatchObject({ title: 'Talent Scout' })
    expect(threadMembers(db, 'group:offsite-crew')).toEqual(['chief', 'talent-scout'])
    // 入职不该把群名弄丢
    expect(conversations.find((c) => c.id === 'group:offsite-crew')!.title).toBe('Offsite crew')
  })

  it('refuses an empty name and a duplicate id', async () => {
    const db = openDb(':memory:')
    const dataDir = newDir()
    await expect(createBot(db, { dataDir, name: '  ', role: 'x' })).rejects.toThrow(/name/i)
    await createBot(db, { dataDir, name: 'Ops', role: 'x' })
    await expect(createBot(db, { dataDir, name: 'Ops', role: 'y' })).rejects.toThrow(/already/i)
  })

  it('works without a group', async () => {
    const db = openDb(':memory:')
    const bot = await createBot(db, { dataDir: newDir(), name: 'Solo', role: 'x' })
    expect(bot.id).toBe('solo')
  })
})
