import { describe, expect, it } from 'vitest'
import { openDb, upsertBot } from '../src/db.js'
import { createRoutine, describeCron, isValidCron, listRoutines, markRoutineRun } from '../src/routines.js'

const bot = { id: 'market-watch', name: 'Ticker', role: 'markets', emoji: '📈', soul_path: '' }

function setup() {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  return db
}

describe('isValidCron', () => {
  it('accepts real expressions and rejects junk', () => {
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('*/5 * * * *')).toBe(true)
    expect(isValidCron('every morning')).toBe(false)
    expect(isValidCron('')).toBe(false)
  })
})

describe('describeCron', () => {
  it('turns common shapes into plain English', () => {
    expect(describeCron('0 9 * * *')).toBe('every day at 09:00')
    expect(describeCron('30 17 * * 5')).toBe('every Friday at 17:30')
    expect(describeCron('*/5 * * * *')).toBe('every 5 minutes')
    expect(describeCron('* * * * *')).toBe('every minute')
    expect(describeCron('0 8 1 * *')).toBe('day 1 of each month at 08:00')
  })

  it('falls back to the raw expression when it is unusual', () => {
    expect(describeCron('7 3 2 1 *')).toBe('7 3 2 1 *')
  })
})

describe('routines store', () => {
  it('creates and lists routines newest first', () => {
    const db = setup()
    createRoutine(db, { botId: bot.id, name: 'Morning digest', cron: '0 9 * * *', instructions: 'summarise my list' })
    const second = createRoutine(db, { botId: bot.id, name: 'Close digest', cron: '0 17 * * *', instructions: 'closing prices' })
    const rows = listRoutines(db, bot.id)
    expect(rows.map((r) => r.name)).toEqual(['Close digest', 'Morning digest'])
    expect(rows[0]!.id).toBe(second.id)
    expect(rows[0]!.enabled).toBe(1)
    expect(rows[0]!.last_run_at).toBeNull()
  })

  it('lists every bot when no id is given, and records runs', () => {
    const db = setup()
    upsertBot(db, { ...bot, id: 'researcher', name: 'Scout' })
    const a = createRoutine(db, { botId: 'market-watch', name: 'A', cron: '0 9 * * *', instructions: 'x' })
    createRoutine(db, { botId: 'researcher', name: 'B', cron: '0 9 * * *', instructions: 'y' })
    expect(listRoutines(db)).toHaveLength(2)
    markRoutineRun(db, a.id, 1786600000000)
    expect(listRoutines(db, 'market-watch')[0]!.last_run_at).toBe(1786600000000)
  })
})
