/** SOUL.md 头部可选的 frontmatter：放 role/emoji，让同事的定义跟着文件夹走，而不是只活在数据库里。 */
export type SoulMeta = { role?: string; emoji?: string }

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export function parseSoul(text: string): { meta: SoulMeta; body: string } {
  const match = text.match(FRONTMATTER)
  if (!match) return { meta: {}, body: text }
  const meta: SoulMeta = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!value) continue
    if (key === 'role') meta.role = value
    if (key === 'emoji') meta.emoji = value
  }
  return { meta, body: text.slice(match[0].length) }
}

export function soulFrontmatter(meta: SoulMeta): string {
  // frontmatter 只认单行值，换行一律压平
  const lines = Object.entries(meta)
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `${k}: ${String(v).replace(/\s*\r?\n\s*/g, ' ').trim()}`)
  return lines.length ? `---\n${lines.join('\n')}\n---\n` : ''
}
