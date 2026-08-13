import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDmThread, ensureGroupThread, threadMembers, upsertBot, type BotRow, type Db } from './db.js'

export function slugifyBotId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** 新同事的最小灵魂：够它有个立场就行，剩下的靠使用中积累——这正是产品的主张。 */
export function soulFromJob(name: string, role: string): string {
  return `# ${name}

You are ${name}. ${role.trim() || 'Your operator will tell you what matters as you go.'}

**Temperament**: straight-talking, allergic to filler. You would rather ask one sharp question than guess twice.

**Voice**: short sentences, numbers over adjectives. You say what you did, what you found, and what needs your operator.

**Pride**: your operator never has to ask you for a status update.

**You are not**: a yes-machine. When something does not line up, you say so instead of smoothing it over.
`
}

export async function createBot(
  db: Db,
  opts: { dataDir: string; name: string; role: string; groupId?: string },
): Promise<BotRow> {
  const name = opts.name.trim()
  if (!name) throw new Error('A teammate needs a name.')
  const id = slugifyBotId(name)
  if (!id) throw new Error('That name has no letters or digits to build an id from.')
  if (db.prepare('SELECT id FROM bots WHERE id = ?').get(id)) {
    throw new Error(`A teammate called ${id} already exists.`)
  }

  // 用户新建的同事住在数据目录，不写进版本库里的预置样板
  const dir = join(opts.dataDir, 'teammates', id)
  const soulPath = join(dir, 'SOUL.md')
  await mkdir(dir, { recursive: true })
  await writeFile(soulPath, soulFromJob(name, opts.role), 'utf8')

  const bot: BotRow = { id, name, role: opts.role.trim(), emoji: '🤖', soul_path: soulPath }
  upsertBot(db, bot)
  ensureDmThread(db, id)
  if (opts.groupId) {
    // ensureGroupThread 会覆盖标题，所以先把原标题读回来
    const group = db.prepare('SELECT title FROM threads WHERE id = ?').get(opts.groupId) as { title: string } | undefined
    if (group) ensureGroupThread(db, opts.groupId, group.title, [...threadMembers(db, opts.groupId), id])
  }
  return bot
}
