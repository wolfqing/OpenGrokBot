import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Db, ensureDmThread, ensureGroupThread, upsertBot } from './db.js'
import { parseSoul } from './soul.js'

/** 每个带 SOUL.md 的子目录就是一位同事；role/emoji 取自 SOUL.md 的 frontmatter，没写就保留库里已有的。 */
export function seedTeammates(db: Db, teammatesDir: string): string[] {
  if (!existsSync(teammatesDir)) return [] // 用户目录是可选的，第一次跑还不存在
  const ids: string[] = []
  for (const entry of readdirSync(teammatesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const soulPath = join(teammatesDir, entry.name, 'SOUL.md')
    if (!existsSync(soulPath)) continue
    const { meta, body } = parseSoul(readFileSync(soulPath, 'utf8'))
    const name = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? entry.name
    upsertBot(db, {
      id: entry.name,
      name,
      role: meta.role ?? '',
      emoji: meta.emoji ?? '',
      soul_path: soulPath,
    })
    ensureDmThread(db, entry.name)
    ids.push(entry.name)
  }
  return ids
}

/** 默认群：所有 seed 出来的 bot 都在里面，重启时补齐新同事。 */
export function seedGroup(db: Db, input: { id: string; title: string; memberIds: string[] }): string {
  return ensureGroupThread(db, input.id, input.title, input.memberIds)
}
