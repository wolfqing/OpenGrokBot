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
`

export function openDb(path = ':memory:'): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

export function upsertBot(db: Db, bot: BotRow): void {
  db.prepare(
    `INSERT INTO bots (id, name, role, emoji, soul_path, created_at)
     VALUES (@id, @name, @role, @emoji, @soul_path, @created_at)
     ON CONFLICT(id) DO UPDATE SET name=@name, role=@role, emoji=@emoji, soul_path=@soul_path`,
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
  const dms: Conversation[] = bots.map((b) => ({
    id: `dm:${b.id}`,
    kind: 'dm',
    title: b.name,
    emoji: b.emoji,
    subtitle: b.role,
    members: [b.id],
    last_message: lastMessageOf(db, `dm:${b.id}`),
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
    }
  })
  return [...dms, ...groups]
}
