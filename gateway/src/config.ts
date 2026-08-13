import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Config = {
  baseURL: string
  apiKey: string
  model: string
  port: number
  dataDir: string
  dbPath: string
  teammatesDir: string
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = env.OPENGROKBOT_DATA || fileURLToPath(new URL('../data', import.meta.url))
  return {
    baseURL: env.OPENGROKBOT_API_BASE || 'https://api.x.ai/v1',
    apiKey: env.OPENGROKBOT_API_KEY || '',
    model: env.OPENGROKBOT_MODEL || 'grok-4',
    port: Number(env.OPENGROKBOT_PORT || 4747),
    dataDir,
    dbPath: env.OPENGROKBOT_DB || join(dataDir, 'opengrokbot.db'),
    teammatesDir: env.OPENGROKBOT_TEAMMATES || fileURLToPath(new URL('../../teammates', import.meta.url)),
  }
}
