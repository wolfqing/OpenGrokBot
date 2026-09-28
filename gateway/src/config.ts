import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Config = {
  baseURL: string
  apiKey: string
  model: string
  /** 默认只听本机回环：局域网里的设备碰不到网关 */
  host: string
  port: number
  dataDir: string
  dbPath: string
  teammatesDir: string
  /** 构建好的前端；存在就由网关直接托管，一个端口搞定 */
  webDist: string
  /** 登录链接用的前端地址（dev 下是 Vite 的 5173）；空 = 网关自己 */
  webUrl: string
  chiefId: string
  a2aAllow: string
  groupId: string
  groupTitle: string
  /** 固定网关令牌；空 = 用数据目录里自动生成的那个 */
  token: string
  /** 反代等场景下 Host 与 Origin 对不上时，额外放行的来源 */
  allowedOrigins: string[]
  llmTimeoutMs: number
  llmRetries: number
  /** 每个 bot 每天的 token 上限；0 = 不限 */
  dailyTokens: number
  /** 把截图喂回模型（需要支持图片输入的模型） */
  vision: boolean
  /** 电脑空闲多少分钟后停机；0 = 永不 */
  idleStopMinutes: number
  botMemoryMb: number
  botCpus: number
  timeZone: string
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function flag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = env.OPENGROKBOT_DATA || fileURLToPath(new URL('../data', import.meta.url))
  return {
    baseURL: env.OPENGROKBOT_API_BASE || 'https://api.x.ai/v1',
    apiKey: env.OPENGROKBOT_API_KEY || '',
    model: env.OPENGROKBOT_MODEL || 'grok-4',
    host: env.OPENGROKBOT_HOST || '127.0.0.1',
    port: num(env.OPENGROKBOT_PORT, 4747),
    dataDir,
    dbPath: env.OPENGROKBOT_DB || join(dataDir, 'opengrokbot.db'),
    teammatesDir: env.OPENGROKBOT_TEAMMATES || fileURLToPath(new URL('../../teammates', import.meta.url)),
    webDist: env.OPENGROKBOT_WEB_DIST || fileURLToPath(new URL('../../web/dist', import.meta.url)),
    webUrl: (env.OPENGROKBOT_WEB_URL || '').replace(/\/$/, ''),
    chiefId: env.OPENGROKBOT_CHIEF || 'chief',
    // 同级互发默认关闭：`researcher>market-watch,market-watch>researcher`
    a2aAllow: env.OPENGROKBOT_A2A_ALLOW || '',
    groupId: env.OPENGROKBOT_GROUP_ID || 'group:offsite-crew',
    groupTitle: env.OPENGROKBOT_GROUP_TITLE || 'Offsite crew',
    token: (env.OPENGROKBOT_TOKEN || '').trim(),
    allowedOrigins: (env.OPENGROKBOT_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    llmTimeoutMs: num(env.OPENGROKBOT_LLM_TIMEOUT_MS, 120_000),
    llmRetries: num(env.OPENGROKBOT_LLM_RETRIES, 2),
    dailyTokens: num(env.OPENGROKBOT_DAILY_TOKENS, 0),
    vision: flag(env.OPENGROKBOT_VISION),
    idleStopMinutes: num(env.OPENGROKBOT_IDLE_STOP_MINUTES, 60),
    botMemoryMb: num(env.OPENGROKBOT_BOT_MEMORY_MB, 2048),
    botCpus: num(env.OPENGROKBOT_BOT_CPUS, 2),
    timeZone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }
}
