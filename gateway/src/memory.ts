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

/** v0.2.0 把 MEMORY.md 放在 workspace 里；第一次读到时搬过来。 */
async function migrateLegacyMemory(dataDir: string, botId: string): Promise<void> {
  const target = memoryPath(dataDir, botId)
  const legacy = join(workspaceDir(dataDir, botId), 'MEMORY.md')
  if (existsSync(target) || !existsSync(legacy)) return
  await mkdir(dirname(target), { recursive: true })
  await rename(legacy, target)
}

export async function readMemory(dataDir: string, botId: string): Promise<string> {
  try {
    await migrateLegacyMemory(dataDir, botId)
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
