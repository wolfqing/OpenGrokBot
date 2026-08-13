import Database from 'better-sqlite3'

export type Db = Database.Database
export type MessageKind = 'text' | 'report' | 'screenshot'

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
  created_at INTEGER NOT NULL
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
