import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Cron } from 'croner'
import type { Db } from './db.js'

export type RoutineRow = {
  id: number
  bot_id: string
  name: string
  /** 空串 = 不按时间跑，只等 webhook */
  cron: string
  instructions: string
  enabled: number
  created_at: number
  last_run_at: number | null
  /** 有值 = 外部系统带着这个密钥 POST /hooks/routines/:id 就能叫醒它；从不进模型的上下文 */
  webhook_key: string | null
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

/** 「每天 09:00」「它的 webhook 被调用时」，或两者都有 */
export function describeRoutine(r: { cron: string; webhook_key?: string | null }): string {
  const parts = [r.cron.trim() ? describeCron(r.cron) : '', r.webhook_key ? 'when its webhook is called' : '']
  return parts.filter(Boolean).join(', and ') || 'never (no schedule and no webhook)'
}

export function createRoutine(
  db: Db,
  input: { botId: string; name: string; cron: string; instructions: string; webhook?: boolean },
): RoutineRow {
  const key = input.webhook ? randomBytes(18).toString('base64url') : null
  const info = db.prepare(
    `INSERT INTO routines (bot_id, name, cron, instructions, enabled, created_at, webhook_key)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(input.botId, input.name, input.cron, input.instructions, Date.now(), key)
  return db.prepare('SELECT * FROM routines WHERE id = ?').get(Number(info.lastInsertRowid)) as RoutineRow
}

/** webhook 的入口：id 对得上、密钥逐字节相等（恒定时间比较）才算数；不区分「没这条」和「密钥错」 */
export function routineForWebhook(db: Db, id: number, key: string): RoutineRow | null {
  const routine = Number.isInteger(id) ? getRoutine(db, id) : null
  if (!routine?.webhook_key || !key) return null
  const a = Buffer.from(key)
  const b = Buffer.from(routine.webhook_key)
  return a.length === b.length && timingSafeEqual(a, b) ? routine : null
}

export function listRoutines(db: Db, botId?: string): RoutineRow[] {
  return botId
    ? (db.prepare('SELECT * FROM routines WHERE bot_id = ? ORDER BY enabled DESC, id DESC').all(botId) as RoutineRow[])
    : (db.prepare('SELECT * FROM routines ORDER BY enabled DESC, id DESC').all() as RoutineRow[])
}

export function markRoutineRun(db: Db, id: number, at: number): void {
  db.prepare('UPDATE routines SET last_run_at = ? WHERE id = ?').run(at, id)
}

export function getRoutine(db: Db, id: number): RoutineRow | null {
  return (db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined) ?? null
}

export function setRoutineEnabled(db: Db, id: number, enabled: boolean): RoutineRow | null {
  db.prepare('UPDATE routines SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  return getRoutine(db, id)
}

export function deleteRoutine(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM routines WHERE id = ?').run(id).changes > 0
}
