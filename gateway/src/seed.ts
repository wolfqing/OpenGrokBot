import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Db, ensureDmThread, ensureGroupThread, upsertBot } from './db.js'

const EMOJI: Record<string, string> = {
  chief: '🎖️',
  researcher: '🔎',
  'inbox-keeper': '📥',
  'market-watch': '📈',
}

const ROLE: Record<string, string> = {
  chief: 'Keeps the board: who owns what, by when, and what needs you today',
  researcher: 'Turns a one-line question into a decision-ready brief with sources',
  'inbox-keeper': 'Triages what you forward, drafts replies — drafts only, never sends',
  'market-watch': 'Watches your list, digests and threshold alerts — read-only, never trades',
}

export function seedTeammates(db: Db, teammatesDir: string): string[] {
  if (!existsSync(teammatesDir)) return [] // 用户目录是可选的，第一次跑还不存在
  const ids: string[] = []
  for (const entry of readdirSync(teammatesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const soulPath = join(teammatesDir, entry.name, 'SOUL.md')
    if (!existsSync(soulPath)) continue
    const soul = readFileSync(soulPath, 'utf8')
    const name = soul.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? entry.name
    upsertBot(db, {
      id: entry.name,
      name,
      role: ROLE[entry.name] ?? '',
      emoji: EMOJI[entry.name] ?? '🤖',
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
