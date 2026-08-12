import { fileURLToPath } from 'node:url'

export type Config = {
  baseURL: string
  apiKey: string
  model: string
  port: number
  dbPath: string
  teammatesDir: string
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    baseURL: env.OPENGROKBOT_API_BASE || 'https://api.x.ai/v1',
    apiKey: env.OPENGROKBOT_API_KEY || '',
    model: env.OPENGROKBOT_MODEL || 'grok-4',
    port: Number(env.OPENGROKBOT_PORT || 4747),
    dbPath: env.OPENGROKBOT_DB || fileURLToPath(new URL('../data/opengrokbot.db', import.meta.url)),
    teammatesDir: env.OPENGROKBOT_TEAMMATES || fileURLToPath(new URL('../../teammates', import.meta.url)),
  }
}
