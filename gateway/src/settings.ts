import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComputerChoice } from './backend.js'
import { loadConfig, type Config } from './config.js'
import type { Db } from './db.js'
import { providerById } from './providers.js'

/**
 * 操作者在界面上改的设置。存在 settings 表里；同名环境变量设了就以环境变量为准（界面上显示为锁定）。
 * API key 不进数据库（库文件是默认权限），单独放 <data>/llm-key，0600，和网关令牌同级。
 */
export type Language = '' | 'en' | 'zh-CN'
export type Settings = {
  /** 服务商预设的 id；空 = 没选过（自定义或环境变量配的） */
  provider: string
  baseURL: string
  model: string
  vision: boolean
  /** 空 = 跟系统语言 */
  language: Language
  computers: ComputerChoice
  browserMirror: string
  checkUpdates: boolean
}
export type SettingKey = keyof Settings
export type SettingSource = 'env' | 'saved' | 'default'

/** 和 loadConfig({}) 的默认值一致（有测试盯着） */
export const SETTING_DEFAULTS: Settings = {
  provider: '',
  baseURL: 'https://api.x.ai/v1',
  model: 'grok-4',
  vision: false,
  language: '',
  computers: 'auto',
  browserMirror: '',
  checkUpdates: true,
}

/** 能锁住某项设置的环境变量；没列的项只能在界面上改 */
const ENV: Partial<Record<SettingKey, string>> = {
  baseURL: 'OPENGROKBOT_API_BASE',
  model: 'OPENGROKBOT_MODEL',
  vision: 'OPENGROKBOT_VISION',
  computers: 'OPENGROKBOT_COMPUTERS',
  browserMirror: 'OPENGROKBOT_BROWSER_MIRROR',
}
const API_KEY_ENV = 'OPENGROKBOT_API_KEY'

const httpUrl = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 2048) return false
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
const CONTROL = /[\u0000-\u001f\u007f]/

/** 合法就返回规范化后的值，不合法返回 undefined */
const PARSE: { [K in SettingKey]: (v: unknown) => Settings[K] | undefined } = {
  provider: (v) => typeof v === 'string' && providerById(v) ? v : undefined,
  baseURL: (v) => httpUrl(v) ? v.replace(/\/+$/, '') : undefined,
  model: (v) => {
    if (typeof v !== 'string') return undefined
    const m = v.trim()
    return m && m.length <= 200 && !CONTROL.test(m) ? m : undefined
  },
  vision: (v) => typeof v === 'boolean' ? v : undefined,
  language: (v) => v === 'en' || v === 'zh-CN' ? v : undefined,
  computers: (v) => v === 'auto' || v === 'docker' || v === 'local' ? v : undefined,
  browserMirror: (v) => v === '' || httpUrl(v) ? (v as string).replace(/\/+$/, '') : undefined,
  checkUpdates: (v) => typeof v === 'boolean' ? v : undefined,
}
const isKey = (k: string): k is SettingKey => Object.hasOwn(PARSE, k)

/** 库里存着的设置；认不出的键（更新的版本写的）和坏掉的值直接跳过，不让网关因此起不来 */
export function readSavedSettings(db: Db): Partial<Settings> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const out: Partial<Record<SettingKey, unknown>> = {}
  for (const { key, value } of rows) {
    if (!isKey(key)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      continue
    }
    const v = PARSE[key](parsed)
    if (v !== undefined) out[key] = v
  }
  return out as Partial<Settings>
}

/** 单项校验：合法返回规范化后的值，否则 undefined */
export function parseSetting<K extends SettingKey>(key: K, value: unknown): Settings[K] | undefined {
  return PARSE[key](value)
}

export type SettingError = { key: string; code: 'unknown_setting' | 'invalid' | 'locked' }

/** 只校验不写：null = 恢复默认 */
export function checkSettings(patch: Record<string, unknown>): { errors: SettingError[]; writes: [SettingKey, unknown][] } {
  const errors: SettingError[] = []
  const writes: [SettingKey, unknown][] = []
  for (const [key, raw] of Object.entries(patch)) {
    if (!isKey(key)) {
      errors.push({ key, code: 'unknown_setting' })
      continue
    }
    if (raw === null) {
      writes.push([key, null])
      continue
    }
    const v = PARSE[key](raw)
    if (v === undefined) errors.push({ key, code: 'invalid' })
    else writes.push([key, v])
  }
  return { errors, writes }
}

/** 存一批设置：null = 恢复默认。有一项不对就整批不存。 */
export function saveSettings(db: Db, patch: Record<string, unknown>, now = Date.now()): { ok: true } | { ok: false; errors: SettingError[] } {
  const { errors, writes } = checkSettings(patch)
  if (errors.length) return { ok: false, errors }
  const put = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  )
  const drop = db.prepare('DELETE FROM settings WHERE key = ?')
  db.transaction(() => {
    for (const [key, v] of writes) {
      if (v === null) drop.run(key)
      else put.run(key, JSON.stringify(v), now)
    }
  })()
  return { ok: true }
}

const envSet = (env: Record<string, string | undefined>, name: string | undefined) => !!name && (env[name] ?? '').trim() !== ''

/** 环境变量 > 存着的 > 默认；每项都说清楚来自哪儿 */
export function resolveSettings(
  env: Record<string, string | undefined>,
  saved: Partial<Settings>,
): { values: Settings; sources: Record<SettingKey, SettingSource> } {
  // 环境变量的解析沿用 loadConfig，两边不会各说各话
  const fromEnv = loadConfig(env)
  const values = { ...SETTING_DEFAULTS }
  const sources = {} as Record<SettingKey, SettingSource>
  for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
    if (envSet(env, ENV[key])) {
      Object.assign(values, { [key]: fromEnv[key as keyof Config] })
      sources[key] = 'env'
    } else if (saved[key] !== undefined) {
      Object.assign(values, { [key]: saved[key] })
      sources[key] = 'saved'
    } else {
      sources[key] = 'default'
    }
  }
  return { values, sources }
}

/** 把生效的设置叠到启动配置上（返回新对象，原配置不动） */
export function applySettings(config: Config, s: Settings, apiKey: string): Config {
  return { ...config, baseURL: s.baseURL, model: s.model, vision: s.vision, computers: s.computers, browserMirror: s.browserMirror, apiKey }
}

/** 此刻生效的配置：启动配置 + 库里的设置 + key 文件，环境变量照样优先。每次都现读，改了马上看得到。 */
export function currentConfig(startup: Config, env: Record<string, string | undefined>, db: Db): Config {
  const { values } = resolveSettings(env, readSavedSettings(db))
  return { ...applySettings(startup, values, resolveApiKey(env, startup.dataDir).key), extraBody: providerById(values.provider)?.request ?? {} }
}

const keyPath = (dataDir: string) => join(dataDir, 'llm-key')

/** 要原样放进 Authorization 头：空白和控制字符会把头拆开 */
export function validApiKey(key: string): boolean {
  return key.length > 0 && key.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(key)
}

/** 给界面看的样子：只露开头三个和末尾四个字符；太短的一个都不露 */
export function maskKey(key: string): string {
  if (!key) return ''
  return key.length <= 12 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`
}

/** 哪些设置项被环境变量定死了（含 apiKey） */
export function lockedKeys(env: Record<string, string | undefined>): Set<SettingKey | 'apiKey'> {
  const out = new Set<SettingKey | 'apiKey'>()
  for (const [key, name] of Object.entries(ENV)) if (envSet(env, name)) out.add(key as SettingKey)
  if (envSet(env, API_KEY_ENV)) out.add('apiKey')
  return out
}

export function readApiKey(dataDir: string): string {
  const path = keyPath(dataDir)
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
}

/** 存 key：空 = 删掉。先写临时文件再改名，断电不会留下半个 key；权限总是 0600。 */
export function saveApiKey(dataDir: string, key: string): { ok: true } | { ok: false; code: 'invalid' } {
  const k = key.trim()
  const path = keyPath(dataDir)
  if (!k) {
    rmSync(path, { force: true })
    return { ok: true }
  }
  if (!validApiKey(k)) return { ok: false, code: 'invalid' }
  mkdirSync(dataDir, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${k}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600) // umask 不该把它放宽
  renameSync(tmp, path)
  return { ok: true }
}

export function resolveApiKey(env: Record<string, string | undefined>, dataDir: string): { key: string; source: 'env' | 'file' | 'none' } {
  if (envSet(env, API_KEY_ENV)) return { key: env[API_KEY_ENV]!.trim(), source: 'env' }
  const key = readApiKey(dataDir)
  return key ? { key, source: 'file' } : { key: '', source: 'none' }
}
