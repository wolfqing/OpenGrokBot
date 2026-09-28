import Database from 'better-sqlite3'

export type Db = Database.Database
export type MessageKind =
  | 'text'
  | 'report'
  | 'screenshot'
  | 'approval_request'
  | 'approval_resolved'
  | 'memory_updated'
  | 'routine_created'
  | 'bot_ref'
  | 'login_request'
  | 'activity'

export type BotRow = {
  id: string
  name: string
  role: string
  emoji: string
  soul_path: string
}

export type MessageRow = {
  id: number
  thread_id: string
  sender: string // 'user' | bot id
  kind: MessageKind
  content: string
  payload: unknown | null
  created_at: number
}

export type SidebarBot = BotRow & { thread_id: string; last_message: MessageRow | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '🤖',
  soul_path TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'dm',
  bot_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_members (
  thread_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, bot_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '',
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  message_id INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_thread ON approvals(thread_id, status);
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  instructions TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_run_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_routines_bot ON routines(bot_id, enabled);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_bot ON usage(bot_id, created_at);
`

export function openDb(path = ':memory:'): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

/** 空的 role/emoji 表示「来源没写」，不能拿它覆盖库里已有的值——否则每次重启都会抹掉新同事的职位。 */
export function upsertBot(db: Db, bot: BotRow): void {
  db.prepare(
    `INSERT INTO bots (id, name, role, emoji, soul_path, created_at)
     VALUES (@id, @name, @role, COALESCE(NULLIF(@emoji, ''), '🤖'), @soul_path, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       name = @name,
       role = CASE WHEN @role <> '' THEN @role ELSE bots.role END,
       emoji = CASE WHEN @emoji <> '' THEN @emoji ELSE bots.emoji END,
       soul_path = @soul_path`,
  ).run({ ...bot, created_at: Date.now() })
}

export function ensureDmThread(db: Db, botId: string): string {
  const id = `dm:${botId}`
  db.prepare(`INSERT OR IGNORE INTO threads (id, kind, bot_id, created_at) VALUES (?, 'dm', ?, ?)`)
    .run(id, botId, Date.now())
  return id
}

export function insertMessage(
  db: Db,
  m: { threadId: string; sender: string; kind: MessageKind; content?: string; payload?: unknown },
): MessageRow {
  const createdAt = Date.now()
  const payloadJson = m.payload === undefined ? null : JSON.stringify(m.payload)
  const info = db.prepare(
    `INSERT INTO messages (thread_id, sender, kind, content, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(m.threadId, m.sender, m.kind, m.content ?? '', payloadJson, createdAt)
  return {
    id: Number(info.lastInsertRowid),
    thread_id: m.threadId,
    sender: m.sender,
    kind: m.kind,
    content: m.content ?? '',
    payload: m.payload ?? null,
    created_at: createdAt,
  }
}

function parseRow(r: Record<string, unknown>): MessageRow {
  return { ...r, payload: r.payload ? JSON.parse(r.payload as string) : null } as MessageRow
}

export function listMessages(db: Db, threadId: string, limit = 200): MessageRow[] {
  const rows = db.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?`)
    .all(threadId, limit) as Record<string, unknown>[]
  return rows.reverse().map(parseRow)
}

export function listBotsWithLastMessage(db: Db): SidebarBot[] {
  const bots = db.prepare(`SELECT * FROM bots ORDER BY name`).all() as BotRow[]
  const lastStmt = db.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1`)
  return bots.map((b) => {
    const threadId = `dm:${b.id}`
    const last = lastStmt.get(threadId) as Record<string, unknown> | undefined
    return { ...b, thread_id: threadId, last_message: last ? parseRow(last) : null }
  })
}

export function getMessage(db: Db, id: number): MessageRow | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? parseRow(row) : null
}

export type UsageTotals = { prompt: number; completion: number; cached: number; total: number }

export function recordUsage(
  db: Db,
  input: { botId: string; threadId: string; usage: { prompt: number; completion: number; cached: number }; at: number },
): void {
  db.prepare(
    `INSERT INTO usage (bot_id, thread_id, prompt_tokens, completion_tokens, cached_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.botId, input.threadId, input.usage.prompt, input.usage.completion, input.usage.cached, input.at)
}

export function usageSince(db: Db, botId: string, since: number): UsageTotals {
  const row = db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(completion_tokens), 0) AS completion,
            COALESCE(SUM(cached_tokens), 0) AS cached
     FROM usage WHERE bot_id = ? AND created_at >= ?`,
  ).get(botId, since) as { prompt: number; completion: number; cached: number }
  return { ...row, total: row.prompt + row.completion }
}

export function updateMessagePayload(db: Db, messageId: number, payload: unknown): void {
  db.prepare('UPDATE messages SET payload = ? WHERE id = ?').run(JSON.stringify(payload), messageId)
}

export type Conversation = {
  id: string
  kind: 'dm' | 'group'
  title: string
  emoji: string
  subtitle: string
  members: string[]
  last_message: MessageRow | null
  /** 这个线程里还等着人拍板的审批数 */
  pending: number
}

export function ensureGroupThread(db: Db, id: string, title: string, memberIds: string[]): string {
  const now = Date.now()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES (?, 'group', NULL, ?, ?)
              ON CONFLICT(id) DO UPDATE SET title = excluded.title`).run(id, title, now)
  const add = db.prepare('INSERT OR IGNORE INTO thread_members (thread_id, bot_id, joined_at) VALUES (?, ?, ?)')
  memberIds.forEach((botId, i) => add.run(id, botId, now + i))
  return id
}

export function threadMembers(db: Db, threadId: string): string[] {
  return (db.prepare('SELECT bot_id FROM thread_members WHERE thread_id = ? ORDER BY joined_at, bot_id')
    .all(threadId) as { bot_id: string }[]).map((r) => r.bot_id)
}

function lastMessageOf(db: Db, threadId: string): MessageRow | null {
  const row = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1')
    .get(threadId) as Record<string, unknown> | undefined
  return row ? parseRow(row) : null
}

export function listConversations(db: Db): Conversation[] {
  const bots = db.prepare('SELECT * FROM bots ORDER BY name').all() as BotRow[]
  const byId = new Map(bots.map((b) => [b.id, b]))
  const pending = new Map((db.prepare(
    `SELECT thread_id, COUNT(*) AS n FROM approvals WHERE status = 'pending' GROUP BY thread_id`,
  ).all() as { thread_id: string; n: number }[]).map((r) => [r.thread_id, r.n]))
  const dms: Conversation[] = bots.map((b) => ({
    id: `dm:${b.id}`,
    kind: 'dm',
    title: b.name,
    emoji: b.emoji,
    subtitle: b.role,
    members: [b.id],
    last_message: lastMessageOf(db, `dm:${b.id}`),
    pending: pending.get(`dm:${b.id}`) ?? 0,
  }))
  const groupRows = db.prepare(`SELECT * FROM threads WHERE kind = 'group' ORDER BY title`)
    .all() as { id: string; title: string }[]
  const groups: Conversation[] = groupRows.map((t) => {
    const members = threadMembers(db, t.id)
    return {
      id: t.id,
      kind: 'group',
      title: t.title,
      emoji: '👥',
      subtitle: members.map((id) => byId.get(id)?.name ?? id).join(', '),
      members,
      last_message: lastMessageOf(db, t.id),
      pending: pending.get(t.id) ?? 0,
    }
  })
  return [...dms, ...groups]
}
