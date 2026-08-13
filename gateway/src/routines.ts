import { Cron } from 'croner'
import type { Db } from './db.js'

export type RoutineRow = {
  id: number
  bot_id: string
  name: string
  cron: string
  instructions: string
  enabled: number
  created_at: number
  last_run_at: number | null
}

export function isValidCron(expr: string): boolean {
  if (!expr.trim()) return false
  try {
    new Cron(expr, { paused: true })
    return true
  } catch {
    return false
  }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** 只覆盖常见形态；认不出就把原始表达式还给用户，好过编一句错的人话。 */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string]
  if (expr.trim() === '* * * * *') return 'every minute'
  const everyN = min.match(/^\*\/(\d+)$/)
  if (everyN && hour === '*' && dom === '*' && month === '*' && dow === '*') return `every ${everyN[1]} minutes`
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && month === '*') {
    const at = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    if (dom === '*' && dow === '*') return `every day at ${at}`
    if (dom === '*' && /^[0-6]$/.test(dow)) return `every ${DAYS[Number(dow)]} at ${at}`
    if (/^\d+$/.test(dom) && dow === '*') return `day ${dom} of each month at ${at}`
  }
  return expr
}

export function createRoutine(
  db: Db,
  input: { botId: string; name: string; cron: string; instructions: string },
): RoutineRow {
  const info = db.prepare(
    `INSERT INTO routines (bot_id, name, cron, instructions, enabled, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(input.botId, input.name, input.cron, input.instructions, Date.now())
  return db.prepare('SELECT * FROM routines WHERE id = ?').get(Number(info.lastInsertRowid)) as RoutineRow
}

export function listRoutines(db: Db, botId?: string): RoutineRow[] {
  return botId
    ? (db.prepare('SELECT * FROM routines WHERE bot_id = ? ORDER BY enabled DESC, id DESC').all(botId) as RoutineRow[])
    : (db.prepare('SELECT * FROM routines ORDER BY enabled DESC, id DESC').all() as RoutineRow[])
}

export function markRoutineRun(db: Db, id: number, at: number): void {
  db.prepare('UPDATE routines SET last_run_at = ? WHERE id = ?').run(at, id)
}
