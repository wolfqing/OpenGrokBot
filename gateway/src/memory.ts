import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { botDataDir, workspaceDir } from './screenshots.js'

const HEADING = '# MEMORY'

/**
 * 放在网关自己的目录里、不挂进容器：规则只能经 save_memory 改（每次都有 diff chip），
 * bot 在自己电脑上写文件改不动「操作者给的规矩」。
 */
export function memoryPath(dataDir: string, botId: string): string {
  return join(botDataDir(dataDir, botId), 'MEMORY.md')
}

const MIGRATED_MARKER = '.memory-left-the-workspaces'

/**
 * v0.2.0 把 MEMORY.md 放在 workspace 里。升级后第一次启动时把它们搬出来，并留一个标记：
 * 之后 bot 再往自己 workspace 里写 MEMORY.md，也绝不会被当成「操作者给的规矩」搬进来。
 */
export async function migrateLegacyMemories(dataDir: string, botIds: string[]): Promise<string[]> {
  const marker = join(dataDir, 'bots', MIGRATED_MARKER)
  if (existsSync(marker)) return []
  const moved: string[] = []
  for (const botId of botIds) {
    const target = memoryPath(dataDir, botId)
    const legacy = join(workspaceDir(dataDir, botId), 'MEMORY.md')
    if (existsSync(target) || !existsSync(legacy)) continue
    await mkdir(dirname(target), { recursive: true })
    await rename(legacy, target)
    moved.push(botId)
  }
  await mkdir(dirname(marker), { recursive: true })
  await writeFile(marker, `${new Date().toISOString()}\n`, 'utf8')
  return moved
}

/** 只读网关自己的那份；workspace 里的同名文件是 bot 能改的，一概不认。 */
export async function readMemory(dataDir: string, botId: string): Promise<string> {
  try {
    return await readFile(memoryPath(dataDir, botId), 'utf8')
  } catch {
    return ''
  }
}

const rulesIn = (text: string): string[] =>
  text.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim())

export async function listMemoryRules(dataDir: string, botId: string): Promise<string[]> {
  return rulesIn(await readMemory(dataDir, botId))
}

export async function appendMemoryRule(
  dataDir: string,
  botId: string,
  rule: string,
): Promise<{ rule: string; diff: string; total: number }> {
  const clean = rule.trim()
  const path = memoryPath(dataDir, botId)
  const existing = await readMemory(dataDir, botId)
  const rules = rulesIn(existing)
  // 判重和删除用同一把尺子（不计大小写、句末标点）：否则存进两条「一样」的，之后哪条都删不掉
  if (rules.some((r) => comparable(r) === comparable(clean))) return { rule: clean, diff: '', total: rules.length }

  const body = existing.trim() ? `${existing.replace(/\n+$/, '')}\n- ${clean}\n` : `${HEADING}\n\n- ${clean}\n`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
  return { rule: clean, diff: `+ - ${clean}`, total: rules.length + 1 }
}

/** 比较规则时不计大小写、多余空格和句末标点：「Never email Acme.」和「never email acme」是同一条 */
const comparable = (text: string) => text.trim().replace(/\s+/g, ' ').replace(/[.。!！]+$/, '').toLowerCase()

export type ForgetResult =
  | { removed: string; diff: string; total: number }
  | { removed: null; reason: 'none' | 'ambiguous'; candidates: string[] }

/** 转述里不算数的词：「forget the rule about quiet accounts」真正指认规则的只有 quiet、accounts */
const FILLER = new Set(['the', 'that', 'this', 'rule', 'rules', 'about', 'one', 'my', 'your', 'from', 'now', 'on'])
const keywords = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !FILLER.has(w))

/**
 * 删掉一条规则，原文其余部分（标题、空行）一概不动。
 * exact=true（操作者在面板上点 ✕）只认原句；否则（bot 转述「忘掉那条关于 X 的」）依次认：原句、
 * 唯一包含这段话的那条、唯一包含这段话里所有关键词的那条——两条都沾边就不删，把候选还回去让它问清楚。
 */
export async function removeMemoryRule(
  dataDir: string,
  botId: string,
  rule: string,
  opts: { exact?: boolean } = {},
): Promise<ForgetResult> {
  const existing = await readMemory(dataDir, botId)
  const rules = rulesIn(existing)
  const wanted = comparable(rule)
  let hits = rules.filter((r) => comparable(r) === wanted)
  if (!hits.length && !opts.exact && wanted.length >= 4) hits = rules.filter((r) => comparable(r).includes(wanted))
  const words = keywords(wanted)
  if (!hits.length && !opts.exact && words.length) {
    hits = rules.filter((r) => { const have = keywords(comparable(r)); return words.every((w) => have.includes(w)) })
  }
  const unique = [...new Set(hits)]
  if (unique.length === 0) return { removed: null, reason: 'none', candidates: rules }
  if (unique.length > 1) return { removed: null, reason: 'ambiguous', candidates: unique }
  const target = unique[0]!
  const lines = existing.split('\n')
  const at = lines.findIndex((line) => line.startsWith('- ') && line.slice(2).trim() === target)
  lines.splice(at, 1)
  await writeFile(memoryPath(dataDir, botId), lines.join('\n'), 'utf8')
  return { removed: target, diff: `- - ${target}`, total: rules.length - 1 }
}
