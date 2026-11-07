import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseComputerChoice, type ComputerChoice } from './backend.js'

export type Config = {
  /** 同事的电脑是什么做的：auto = 有 Docker 用 Docker，否则本机模式 */
  computers: ComputerChoice
  /** 本机模式用的浏览器可执行文件；空 = 自己找（Chrome/Edge/…），找不到就下载 */
  browser: string
  /** 下载浏览器时给 playwright 的镜像主机；空 = 官方 */
  browserMirror: string
  baseURL: string
  apiKey: string
  model: string
  /** 所选服务商要额外带的请求字段（预设里来，见 providers.ts）；环境变量配的为空 */
  extraBody: Record<string, unknown>
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
  /** 一个回合最多调几次模型 */
  maxSteps: number
  /** 一个回合最长几分钟；0 = 不限 */
  turnMinutes: number
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function flag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

/** 改名为 OpenSuperBot 之前，变量都叫 OPENGROKBOT_*：老的 launchd / systemd / 计划任务配置里还写着它们 */
const LEGACY_ENV_PREFIX = 'OPENGROKBOT_'
const ENV_PREFIX = 'OPENSUPERBOT_'

/**
 * 老名字照样生效：新名字没设时，用老名字的值顶上（直接写回 env，读环境变量的地方就都不用管改名）。
 * 两个都设了以新的为准。返回用上的和被盖住的老名字，好让启动日志提醒一句；值本身不往外报（里面有 key）。
 */
export function adoptLegacyEnv(env: Record<string, string | undefined>): { adopted: string[]; shadowed: string[] } {
  const adopted: string[] = []
  const shadowed: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue
    const current = ENV_PREFIX + name.slice(LEGACY_ENV_PREFIX.length)
    if (env[current] === undefined) {
      env[current] = value
      adopted.push(name)
    } else {
      shadowed.push(name)
    }
  }
  return { adopted, shadowed }
}

/** 改名前的库叫 opengrokbot.db：数据目录里只有它，就接着用它。不搬文件，老网关可能还开着它 */
export function defaultDbPath(dataDir: string, exists: (path: string) => boolean = existsSync): string {
  const current = join(dataDir, 'opensuperbot.db')
  const legacy = join(dataDir, 'opengrokbot.db')
  return !exists(current) && exists(legacy) ? legacy : current
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // 一律转成绝对路径：相对路径传给 docker 的 bind 会被当成卷名直接报错
  const dataDir = resolve(env.OPENSUPERBOT_DATA || fileURLToPath(new URL('../data', import.meta.url)))
  return {
    baseURL: env.OPENSUPERBOT_API_BASE || 'https://api.x.ai/v1',
    apiKey: env.OPENSUPERBOT_API_KEY || '',
    model: env.OPENSUPERBOT_MODEL || 'grok-4.7',
    extraBody: {},
    computers: parseComputerChoice(env.OPENSUPERBOT_COMPUTERS),
    browser: (env.OPENSUPERBOT_BROWSER || '').trim(),
    browserMirror: (env.OPENSUPERBOT_BROWSER_MIRROR || '').trim(),
    host: env.OPENSUPERBOT_HOST || '127.0.0.1',
    port: num(env.OPENSUPERBOT_PORT, 4747),
    dataDir,
    dbPath: env.OPENSUPERBOT_DB === ':memory:' ? ':memory:' : resolve(env.OPENSUPERBOT_DB || defaultDbPath(dataDir)),
    teammatesDir: env.OPENSUPERBOT_TEAMMATES || fileURLToPath(new URL('../../teammates', import.meta.url)),
    webDist: env.OPENSUPERBOT_WEB_DIST || fileURLToPath(new URL('../../web/dist', import.meta.url)),
    webUrl: (env.OPENSUPERBOT_WEB_URL || '').replace(/\/$/, ''),
    chiefId: env.OPENSUPERBOT_CHIEF || 'chief',
    // 同级互发默认关闭：`researcher>market-watch,market-watch>researcher`
    a2aAllow: env.OPENSUPERBOT_A2A_ALLOW || '',
    groupId: env.OPENSUPERBOT_GROUP_ID || 'group:offsite-crew',
    groupTitle: env.OPENSUPERBOT_GROUP_TITLE || 'Offsite crew',
    token: (env.OPENSUPERBOT_TOKEN || '').trim(),
    allowedOrigins: (env.OPENSUPERBOT_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    llmTimeoutMs: num(env.OPENSUPERBOT_LLM_TIMEOUT_MS, 120_000),
    llmRetries: num(env.OPENSUPERBOT_LLM_RETRIES, 2),
    dailyTokens: num(env.OPENSUPERBOT_DAILY_TOKENS, 0),
    vision: flag(env.OPENSUPERBOT_VISION),
    idleStopMinutes: num(env.OPENSUPERBOT_IDLE_STOP_MINUTES, 60),
    botMemoryMb: num(env.OPENSUPERBOT_BOT_MEMORY_MB, 2048),
    botCpus: num(env.OPENSUPERBOT_BOT_CPUS, 2),
    timeZone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    maxSteps: num(env.OPENSUPERBOT_MAX_STEPS, 40) || 40,
    turnMinutes: num(env.OPENSUPERBOT_TURN_MINUTES, 20),
  }
}
