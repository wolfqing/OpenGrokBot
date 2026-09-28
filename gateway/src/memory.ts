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

export async function appendMemoryRule(
  dataDir: string,
  botId: string,
  rule: string,
): Promise<{ rule: string; diff: string; total: number }> {
  const clean = rule.trim()
  const path = memoryPath(dataDir, botId)
  const existing = await readMemory(dataDir, botId)
  const rules = existing.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim())
  if (rules.includes(clean)) return { rule: clean, diff: '', total: rules.length }

  const body = existing.trim() ? `${existing.replace(/\n+$/, '')}\n- ${clean}\n` : `${HEADING}\n\n- ${clean}\n`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
  return { rule: clean, diff: `+ - ${clean}`, total: rules.length + 1 }
}
