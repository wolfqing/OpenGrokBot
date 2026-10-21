import type { Db } from './db.js'

export type ApprovalStatus = 'pending' | 'approved' | 'discarded'

/**
 * bot 申报的动作类别。规则按「哪位同事 · 哪一类 · 发给谁」精确匹配；
 * 申报是 bot 自己填的，所以规则只决定「要不要再问你一次」，动作本身仍在它自己的电脑上执行。
 */
export const APPROVAL_KINDS = ['email', 'message', 'post', 'purchase', 'booking', 'other'] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

/** 花钱、订东西、说不清是什么的，永远一件一问；只有「发给固定对象的话」可以记成规则 */
export const RULEABLE_KINDS: ReadonlySet<ApprovalKind> = new Set(['email', 'message', 'post'])

export const RULE_DURATIONS = { '1h': 60 * 60_000, '24h': 24 * 60 * 60_000, always: null } as const
export type RuleDuration = keyof typeof RULE_DURATIONS

export type ApprovalRow = {
  id: number
  thread_id: string
  bot_id: string
  action: string
  detail: string
  kind: ApprovalKind
  target: string
  status: ApprovalStatus
  message_id: number | null
  rule_id: number | null
  created_at: number
  resolved_at: number | null
}

export type ApprovalRuleRow = {
  id: number
  bot_id: string
  kind: ApprovalKind
  target: string
  expires_at: number | null
  created_at: number
  source_approval_id: number | null
  revoked_at: number | null
}

export function normalizeKind(value: unknown): ApprovalKind {
  const v = String(value ?? '').trim().toLowerCase()
  return (APPROVAL_KINDS as readonly string[]).includes(v) ? (v as ApprovalKind) : 'other'
}

/** 去向按「同一个地方」比较：去首尾空白、压掉多余空格、不分大小写；超长的截断 */
export function normalizeTarget(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 200)
}

export function isRuleDuration(value: unknown): value is RuleDuration {
  return typeof value === 'string' && Object.hasOwn(RULE_DURATIONS, value)
}

/** 群发对象、泛称：说的是「所有人」，不是一个去向 */
const EVERYONE = new Set([
  'all', 'everyone', 'everybody', 'anyone', 'anybody', 'any', 'people', 'public', 'here', 'channel', 'team', 'the team',
  'customers', 'all customers', 'users', 'all users', 'subscribers', 'all subscribers', 'list', 'the list',
  'mailing list', 'contacts', 'all contacts', 'internet', 'the internet', 'world',
])

/** 整个平台或服务：「发到 Twitter」不是一个去向，「发到 @acme」才是 */
const SERVICES = new Set([
  'email', 'mail', 'gmail', 'outlook', 'slack', 'discord', 'telegram', 'whatsapp', 'signal', 'teams', 'microsoft teams',
  'imessage', 'sms', 'wechat', 'messenger', 'x', 'twitter', 'linkedin', 'reddit', 'facebook', 'instagram', 'mastodon',
  'bluesky', 'bsky', 'threads', 'hacker news', 'hn', 'youtube', 'tiktok', 'github', 'medium', 'substack', 'blog',
  'web', 'website',
])

const EMAIL_ADDRESS = /^[^\s@,;<>()"'*]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/
/** 只有域名、没有路径：说的是整个网站 */
const WHOLE_SITE = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/

/**
 * 去向是不是「一个确定的地方」，按类别看形状。不是的话返回一句给人看的原因。
 * 只有一个确定去向的放行才能记成规则：通配、名单、泛称和整个平台记下来，就等于这一类全放。
 * 传进来的应当是 normalizeTarget 之后的值。
 */
export function destinationProblem(kind: ApprovalKind, target: string): string | null {
  if (!target) return 'there is no destination'
  if (target.includes('*')) return `"${target}" is a wildcard, not one destination`
  if (/[,;|\n]/.test(target) || /\s(and|or|&|\+)\s/.test(target)) return `"${target}" names more than one destination`
  if (EVERYONE.has(target) || /^(all|every|any)\b/.test(target) || /(^|\s)@(everyone|here|channel|all)\b/.test(target)) {
    return `"${target}" means everyone, not one destination`
  }
  if (SERVICES.has(target)) return `"${target}" is a whole service, not one destination`
  if (kind === 'email') return EMAIL_ADDRESS.test(target) ? null : `"${target}" is not a single email address`
  if (WHOLE_SITE.test(target) && !target.includes('@')) return `"${target}" is a whole site, not one destination`
  if (kind === 'post' && !/[/@#]/.test(target)) {
    return `"${target}" does not name one account, page, channel or thread`
  }
  return null
}

/** 能不能把这次放行记成规则：类别允许，而且去向是一个确定的地方 */
export function canRemember(approval: { kind: ApprovalKind; target: string }): boolean {
  return RULEABLE_KINDS.has(approval.kind) && destinationProblem(approval.kind, approval.target) === null
}

/** 为什么不能记成规则（给人看）；能记的话返回 null */
export function rememberBlock(approval: { kind: ApprovalKind; target: string }): string | null {
  if (!RULEABLE_KINDS.has(approval.kind)) return 'purchases, bookings and "other" actions always ask'
  return destinationProblem(approval.kind, approval.target)
}

export function createApproval(
  db: Db,
  input: {
    threadId: string
    botId: string
    action: string
    detail?: string
    kind?: ApprovalKind
    target?: string
    /** 命中了规则：直接以已放行落库，记下是哪条规则 */
    ruleId?: number
    now?: number
  },
): ApprovalRow {
  const at = input.now ?? Date.now()
  const auto = input.ruleId !== undefined
  const info = db.prepare(
    `INSERT INTO approvals (thread_id, bot_id, action, detail, kind, target, status, rule_id, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.threadId, input.botId, input.action, input.detail ?? '', input.kind ?? 'other', input.target ?? '',
    auto ? 'approved' : 'pending', input.ruleId ?? null, at, auto ? at : null,
  )
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

/** 操作者在放行时说「以后这类都放」：只认可记成规则的类别和有去向的审批 */
export function createRule(
  db: Db,
  input: { botId: string; kind: ApprovalKind; target: string; duration: RuleDuration; now: number; sourceApprovalId?: number },
): ApprovalRuleRow {
  const target = normalizeTarget(input.target)
  const blocked = rememberBlock({ kind: input.kind, target })
  if (blocked) throw new Error(`cannot remember this: ${blocked}`)
  const span = RULE_DURATIONS[input.duration]
  const info = db.prepare(
    `INSERT INTO approval_rules (bot_id, kind, target, expires_at, created_at, source_approval_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.botId, input.kind, target, span === null ? null : input.now + span, input.now, input.sourceApprovalId ?? null)
  return getRule(db, Number(info.lastInsertRowid))!
}

export function getRule(db: Db, id: number): ApprovalRuleRow | null {
  return (db.prepare('SELECT * FROM approval_rules WHERE id = ?').get(id) as ApprovalRuleRow | undefined) ?? null
}

const ACTIVE = 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)'

/** 精确匹配：同一位同事、同一类、同一个去向，规则还没撤也没过期；类别和去向也得仍然允许记成规则（老的模糊规则就此失效） */
export function findMatchingRule(
  db: Db,
  input: { botId: string; kind: ApprovalKind; target: string; now: number },
): ApprovalRuleRow | null {
  const target = normalizeTarget(input.target)
  if (!canRemember({ kind: input.kind, target })) return null
  return (db.prepare(
    `SELECT * FROM approval_rules WHERE bot_id = ? AND kind = ? AND target = ? AND ${ACTIVE} ORDER BY id DESC LIMIT 1`,
  ).get(input.botId, input.kind, target, input.now) as ApprovalRuleRow | undefined) ?? null
}

export function listActiveRules(db: Db, botId: string, now: number): ApprovalRuleRow[] {
  return db.prepare(`SELECT * FROM approval_rules WHERE bot_id = ? AND ${ACTIVE} ORDER BY id DESC`)
    .all(botId, now) as ApprovalRuleRow[]
}

/** 撤销是幂等的：已经撤过的返回 null */
export function revokeRule(db: Db, id: number, now: number): ApprovalRuleRow | null {
  const info = db.prepare('UPDATE approval_rules SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id)
  return info.changes === 0 ? null : getRule(db, id)
}

/** 给人看的一句话：「email → bob@acme.com」 */
export function describeRule(rule: { kind: string; target: string }): string {
  return `${rule.kind} → ${rule.target}`
}
