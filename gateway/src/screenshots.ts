import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Shot } from './computer.js'

const SAFE_ID = /^[a-zA-Z0-9._-]+$/
const SCREENSHOT_FILE = /^\d+\.png$/

export function workspaceDir(dataDir: string, botId: string): string {
  return join(dataDir, 'workspaces', botId)
}

export async function saveScreenshot(
  dataDir: string,
  botId: string,
  shot: Shot,
  now: number,
): Promise<{ url: string; width: number; height: number }> {
  const dir = join(workspaceDir(dataDir, botId), 'screenshots')
  await mkdir(dir, { recursive: true })
  const file = `${now}.png`
  await writeFile(join(dir, file), shot.buffer)
  return { url: `/api/screenshots/${botId}/${file}`, width: shot.width, height: shot.height }
}

export function screenshotFilePath(dataDir: string, botId: string, file: string): string | null {
  if (!SAFE_ID.test(botId) || botId === '..') return null
  if (!SCREENSHOT_FILE.test(file)) return null
  return join(workspaceDir(dataDir, botId), 'screenshots', file)
}
