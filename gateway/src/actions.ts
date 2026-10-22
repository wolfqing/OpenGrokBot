import type { Db } from './db.js'

/**
 * 每位同事做过的每一步，一行一条：用了哪个工具、对什么、成没成、花了多久、是谁叫它开始的。
 * activity 卡片只活在一个回合里、最多 40 步；这张表跨回合留底，回答「它上周二到底发了什么」。
 * 敲进网页的文字不进日志（只记敲进了哪个框），免得把密码、草稿原文抄一份。
 */
export type ActionTrigger = 'you' | 'group' | 'handoff' | 'approval' | 'question' | 'routine' | 'watch' | 'webhook'

export type ActionEntry = {
  id: number
  bot_id: string
  thread_id: string
  trigger: ActionTrigger | ''
  tool: string
  summary: string
  /** null = 不是「成没成」的事，比如一次放行决定 */
  ok: boolean | null
  ms: number | null
  created_at: number
}

const MAX_SUMMARY = 200

export function recordAction(
  db: Db,
  a: { botId: string; threadId: string; trigger: ActionTrigger; tool: string; summary: string; ok?: boolean | null; ms?: number | null; at: number },
): void {
  db.prepare(
    `INSERT INTO actions (bot_id, thread_id, trigger, tool, summary, ok, ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.botId, a.threadId, a.trigger, a.tool, a.summary.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY),
    a.ok === undefined || a.ok === null ? null : a.ok ? 1 : 0, a.ms ?? null, a.at,
  )
}

/** 最新的在前 */
export function listActions(db: Db, botId: string, limit = 30): ActionEntry[] {
  const rows = db.prepare('SELECT * FROM actions WHERE bot_id = ? ORDER BY id DESC LIMIT ?')
    .all(botId, Math.max(1, Math.min(limit, 500))) as (Omit<ActionEntry, 'ok'> & { ok: number | null })[]
  return rows.map((r) => ({ ...r, ok: r.ok === null ? null : r.ok === 1 }))
}

/** 早于 before 的删掉，返回删了几行 */
export function pruneActions(db: Db, before: number): number {
  return db.prepare('DELETE FROM actions WHERE created_at < ?').run(before).changes
}
