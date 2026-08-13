import type { Db } from './db.js'

export type ApprovalStatus = 'pending' | 'approved' | 'discarded'

export type ApprovalRow = {
  id: number
  thread_id: string
  bot_id: string
  action: string
  detail: string
  status: ApprovalStatus
  message_id: number | null
  created_at: number
  resolved_at: number | null
}

export function createApproval(
  db: Db,
  input: { threadId: string; botId: string; action: string; detail?: string },
): ApprovalRow {
  const info = db.prepare(
    `INSERT INTO approvals (thread_id, bot_id, action, detail, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(input.threadId, input.botId, input.action, input.detail ?? '', Date.now())
  return getApproval(db, Number(info.lastInsertRowid))!
}

export function attachApprovalMessage(db: Db, approvalId: number, messageId: number): void {
  db.prepare('UPDATE approvals SET message_id = ? WHERE id = ?').run(messageId, approvalId)
}

export function getApproval(db: Db, id: number): ApprovalRow | null {
  return (db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined) ?? null
}

export function latestPendingApproval(db: Db, threadId: string): ApprovalRow | null {
  return (db.prepare(
    `SELECT * FROM approvals WHERE thread_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
  ).get(threadId) as ApprovalRow | undefined) ?? null
}

/** 只有 pending 能被解决；重复点击返回 null，调用方据此跳过重复放行。 */
export function resolveApproval(db: Db, id: number, decision: 'approve' | 'discard'): ApprovalRow | null {
  const status: ApprovalStatus = decision === 'approve' ? 'approved' : 'discarded'
  const info = db.prepare(
    `UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
  ).run(status, Date.now(), id)
  return info.changes === 0 ? null : getApproval(db, id)
}

/** 一个光秃秃的 👍 就是放行——去掉肤色、变体选择符和空白后必须只剩这一个字符。 */
export function isThumbsUp(text: string): boolean {
  return text.replace(/[\u{1F3FB}-\u{1F3FF}︎️‍]/gu, '').trim() === '👍'
}
