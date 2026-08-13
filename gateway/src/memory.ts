import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { workspaceDir } from './screenshots.js'

const HEADING = '# MEMORY'

/** 放在 bot 自己的 workspace 里：宿主直接读写，容器里也能 read_file 看到同一份。 */
export function memoryPath(dataDir: string, botId: string): string {
  return join(workspaceDir(dataDir, botId), 'MEMORY.md')
}

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
