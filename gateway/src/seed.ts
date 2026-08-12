import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Db, ensureDmThread, upsertBot } from './db.js'

const EMOJI: Record<string, string> = {
  researcher: '🔎',
  'inbox-keeper': '📥',
  'market-watch': '📈',
}

const ROLE: Record<string, string> = {
  researcher: 'Turns a one-line question into a decision-ready brief with sources',
  'inbox-keeper': 'Triages what you forward, drafts replies — drafts only, never sends',
  'market-watch': 'Watches your list, digests and threshold alerts — read-only, never trades',
}

export function seedTeammates(db: Db, teammatesDir: string): string[] {
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
