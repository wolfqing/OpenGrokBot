import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { restrictToOwner } from './auth.js'
import type { Config, LlmApi } from './config.js'
import type { Db } from './db.js'
import { PROVIDERS, providerById, type Provider } from './providers.js'
import {
  currentConfig, isSubscriptionToken, lockedKeys, parseSetting, readSavedSettings, resolveApiKey, resolveSettings, validApiKey,
} from './settings.js'

/**
 * 模型连接：一家服务商 + 一个 key + 默认模型。同事各选各的，没选的用「默认连接」。
 * 默认连接（id = main）就是设置里原来那一套（向导配的、环境变量能锁住），不在 connections 表里；
 * 另加的连接存表里，key 放 <data>/llm-keys/<id>（0600），和默认连接的 <data>/llm-key 一个待遇。
 */
export const MAIN = 'main'

export type Connection = {
  id: string
  name: string
  provider: string
  api: LlmApi
  baseURL: string
  model: string
  vision: boolean
}

type Row = { id: string; name: string; provider: string; api: string; base_url: string; model: string; vision: number }

const APIS: readonly LlmApi[] = ['chat', 'anthropic', 'responses']
const ID = /^c-[0-9a-f]{8}$/
const CONTROL = /[\u0000-\u001f\u007f]/

export const isConnectionId = (id: string) => id === MAIN || ID.test(id)

const fromRow = (r: Row): Connection => ({
  id: r.id, name: r.name, provider: r.provider, api: APIS.includes(r.api as LlmApi) ? r.api as LlmApi : 'chat',
  baseURL: r.base_url, model: r.model, vision: r.vision === 1,
})

export function listConnections(db: Db): Connection[] {
  return (db.prepare('SELECT * FROM connections ORDER BY created_at, id').all() as Row[]).map(fromRow)
}

export function getConnection(db: Db, id: string): Connection | undefined {
  const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Row | undefined
  return row ? fromRow(row) : undefined
}

/** 默认连接此刻的样子：设置 + 环境变量 + key 文件现读 */
export function mainConnection(startup: Config, env: Record<string, string | undefined>, db: Db): Connection & { config: Config } {
  const config = currentConfig(startup, env, db)
  const { values } = resolveSettings(env, readSavedSettings(db))
  // 没在界面上选过服务商（环境变量配的、老版本升上来的）：按地址认一认是哪家，好叫得出名字
  const provider = providerById(values.provider) ?? PROVIDERS.find((p) => p.baseURL && p.baseURL === config.baseURL)
  return {
    id: MAIN,
    name: provider && provider.id !== 'custom' ? provider.name : '',
    provider: provider?.id ?? '',
    api: config.api,
    baseURL: config.baseURL,
    model: config.model,
    vision: config.vision,
    config,
  }
}

// ---- key 文件 ----

const keysDir = (dataDir: string) => join(dataDir, 'llm-keys')
const keyFile = (dataDir: string, id: string) => join(keysDir(dataDir), id)

export function readConnectionKey(dataDir: string, id: string): string {
  if (!ID.test(id)) return ''
  const path = keyFile(dataDir, id)
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
}

/**
 * 空 = 删掉。先写临时文件、收紧到只有本人能读，再改名；目录 0700。
 * 收紧和网关令牌、默认连接的 key 一样：POSIX 上 0600，Windows 上改 ACL（chmod 在那儿不管权限）
 */
export function saveConnectionKey(
  dataDir: string,
  id: string,
  key: string,
  opts: { restrict?: (path: string) => void; warn?: (line: string) => void } = {},
): void {
  if (!ID.test(id)) throw new Error(`bad connection id ${id}`)
  const path = keyFile(dataDir, id)
  const k = key.trim()
  if (!k) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(keysDir(dataDir), { recursive: true, mode: 0o700 })
  chmodSync(keysDir(dataDir), 0o700)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${k}\n`, { mode: 0o600 })
  try {
    ;(opts.restrict ?? restrictToOwner)(tmp)
  } catch (err) {
    ;(opts.warn ?? console.warn)(`[gateway] could not limit ${path} to your account: ${err instanceof Error ? err.message : String(err)}`)
  }
  renameSync(tmp, path)
}

// ---- 校验 ----

export type ConnectionError = { key: string; code: 'invalid' | 'required' | 'locked' | 'subscription_token' | 'not_found' | 'in_use' }

export type ConnectionInput = {
  name?: unknown
  provider?: unknown
  api?: unknown
  baseURL?: unknown
  model?: unknown
  vision?: unknown
  apiKey?: unknown
}

const parseName = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const n = v.trim()
  return n.length <= 60 && !CONTROL.test(n) ? n : undefined
}

/** key：undefined = 不改；'' / null = 删掉；其余要像个 key，而且不能是 Claude 订阅的登录令牌 */
export function parseKey(v: unknown, errors: ConnectionError[]): string | undefined {
  if (v === undefined) return undefined
  if (v === null) return ''
  if (typeof v !== 'string') {
    errors.push({ key: 'apiKey', code: 'invalid' })
    return undefined
  }
  const k = v.trim()
  if (k && !validApiKey(k)) errors.push({ key: 'apiKey', code: 'invalid' })
  else if (isSubscriptionToken(k)) errors.push({ key: 'apiKey', code: 'subscription_token' })
  else return k
  return undefined
}

type Parsed = { name?: string; provider?: Provider; api?: LlmApi; baseURL?: string; model?: string; vision?: boolean }

function parseFields(input: ConnectionInput, errors: ConnectionError[]): Parsed {
  const out: Parsed = {}
  if (input.name !== undefined) {
    const n = parseName(input.name)
    if (n === undefined) errors.push({ key: 'name', code: 'invalid' })
    else out.name = n
  }
  if (input.provider !== undefined) {
    const p = typeof input.provider === 'string' ? providerById(input.provider) : undefined
    if (!p) errors.push({ key: 'provider', code: 'invalid' })
    else out.provider = p
  }
  if (input.api !== undefined) {
    if (!APIS.includes(input.api as LlmApi)) errors.push({ key: 'api', code: 'invalid' })
    else out.api = input.api as LlmApi
  }
  if (input.baseURL !== undefined) {
    const u = parseSetting('baseURL', input.baseURL)
    if (u === undefined) errors.push({ key: 'baseURL', code: 'invalid' })
    else out.baseURL = u
  }
  if (input.model !== undefined) {
    const m = parseSetting('model', input.model)
    if (m === undefined) errors.push({ key: 'model', code: 'invalid' })
    else out.model = m
  }
  if (input.vision !== undefined) {
    if (typeof input.vision !== 'boolean') errors.push({ key: 'vision', code: 'invalid' })
    else out.vision = input.vision
  }
  return out
}

/**
 * 新加一个连接：服务商必填，其余缺省取预设（地址、默认模型、看图、接口）。
 * 只有「自定义」能自己选接口；预设的接口是按官方文档定的，不让改错。
 */
export function createConnection(
  db: Db, dataDir: string, input: ConnectionInput, now = Date.now(),
): { ok: true; connection: Connection } | { ok: false; errors: ConnectionError[] } {
  const errors: ConnectionError[] = []
  const f = parseFields(input, errors)
  const key = parseKey(input.apiKey, errors)
  if (!f.provider && input.provider === undefined) errors.push({ key: 'provider', code: 'required' })
  const p = f.provider
  const baseURL = f.baseURL ?? p?.baseURL ?? ''
  const model = f.model ?? p?.defaultModel ?? ''
  if (p && !baseURL) errors.push({ key: 'baseURL', code: 'required' })
  if (p && !model) errors.push({ key: 'model', code: 'required' })
  if (errors.length || !p) return { ok: false, errors }
  const connection: Connection = {
    id: `c-${randomBytes(4).toString('hex')}`,
    name: f.name || (p.id === 'custom' ? '' : p.name),
    provider: p.id,
    api: p.id === 'custom' ? f.api ?? 'chat' : p.api,
    baseURL,
    model,
    vision: f.vision ?? p.vision,
  }
  db.prepare(
    `INSERT INTO connections (id, name, provider, api, base_url, model, vision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(connection.id, connection.name, connection.provider, connection.api, connection.baseURL, connection.model, connection.vision ? 1 : 0, now, now)
  if (key) saveConnectionKey(dataDir, connection.id, key)
  return { ok: true, connection }
}

/**
 * 连接换了服务商、接口或地址：同事在它上面单独选的模型多半在新地方不存在（每回合都 404），清掉，回到连接的默认模型。
 * MAIN = 没选过连接、只在默认连接上换了模型的那些同事
 */
export function resetBotModels(db: Db, connectionId: string): void {
  if (connectionId === MAIN) db.prepare('UPDATE bots SET llm_model = NULL WHERE llm_connection IS NULL').run()
  else db.prepare('UPDATE bots SET llm_model = NULL WHERE llm_connection = ?').run(connectionId)
}

/** 改一个另加的连接（默认连接走设置那一套，见 connections-api）。换了地址又没给新 key，旧 key 删掉：绝不把一家的 key 发给另一家 */
export function updateConnection(
  db: Db, dataDir: string, id: string, input: ConnectionInput, now = Date.now(),
): { ok: true; connection: Connection } | { ok: false; errors: ConnectionError[] } {
  const current = getConnection(db, id)
  if (!current) return { ok: false, errors: [{ key: 'id', code: 'not_found' }] }
  const errors: ConnectionError[] = []
  const f = parseFields(input, errors)
  const key = parseKey(input.apiKey, errors)
  if (errors.length) return { ok: false, errors }
  const was = providerById(current.provider)
  const provider = f.provider ?? was
  const switched = Boolean(f.provider && f.provider.id !== current.provider)
  // 名字还是上一家的预设名（没人改过）：换了服务商就跟着换，免得名叫 DeepSeek、实际连着 Claude
  const autoName = current.name === '' || current.name === was?.name
  const next: Connection = {
    ...current,
    ...(switched && autoName ? { name: f.provider!.id === 'custom' ? '' : f.provider!.name } : {}),
    ...(f.name !== undefined ? { name: f.name } : {}),
    ...(f.provider ? { provider: f.provider.id, api: f.provider.id === 'custom' ? f.api ?? current.api : f.provider.api } : {}),
    ...(!f.provider && f.api && provider?.id === 'custom' ? { api: f.api } : {}),
    ...(f.baseURL ? { baseURL: f.baseURL } : switched && f.provider!.baseURL ? { baseURL: f.provider!.baseURL } : {}),
    ...(f.model ? { model: f.model } : switched && f.provider!.defaultModel ? { model: f.provider!.defaultModel } : {}),
    ...(f.vision !== undefined ? { vision: f.vision } : switched ? { vision: f.provider!.vision } : {}),
  }
  db.prepare(
    `UPDATE connections SET name = ?, provider = ?, api = ?, base_url = ?, model = ?, vision = ?, updated_at = ? WHERE id = ?`,
  ).run(next.name, next.provider, next.api, next.baseURL, next.model, next.vision ? 1 : 0, now, id)
  if (key !== undefined) saveConnectionKey(dataDir, id, key)
  else if (next.baseURL !== current.baseURL) saveConnectionKey(dataDir, id, '')
  if (next.provider !== current.provider || next.api !== current.api || next.baseURL !== current.baseURL) resetBotModels(db, id)
  return { ok: true, connection: next }
}

/** 删掉一个连接：用它的同事回到默认连接（返回是哪几位），它的 key 一起删 */
export function deleteConnection(db: Db, dataDir: string, id: string): { ok: true; moved: string[] } | { ok: false; errors: ConnectionError[] } {
  if (!getConnection(db, id)) return { ok: false, errors: [{ key: 'id', code: 'not_found' }] }
  const moved = (db.prepare('SELECT id FROM bots WHERE llm_connection = ? ORDER BY id').all(id) as { id: string }[]).map((r) => r.id)
  db.transaction(() => {
    db.prepare('UPDATE bots SET llm_connection = NULL, llm_model = NULL WHERE llm_connection = ?').run(id)
    db.prepare('DELETE FROM connections WHERE id = ?').run(id)
  })()
  saveConnectionKey(dataDir, id, '')
  return { ok: true, moved }
}

// ---- 同事选哪个 ----

export type BotLlm = { connectionId: string; model: string | null }

/** 同事的选择；选的连接已经没了（或从没选过）就是默认连接 */
export function botLlm(db: Db, botId: string): BotLlm {
  const row = db.prepare('SELECT llm_connection, llm_model FROM bots WHERE id = ?').get(botId) as
    { llm_connection: string | null; llm_model: string | null } | undefined
  const id = row?.llm_connection
  if (!id || !getConnection(db, id)) return { connectionId: MAIN, model: row?.llm_model && !id ? row.llm_model : null }
  return { connectionId: id, model: row?.llm_model ?? null }
}

export function listBotLlms(db: Db): Record<string, BotLlm> {
  const ids = (db.prepare('SELECT id FROM bots ORDER BY id').all() as { id: string }[]).map((r) => r.id)
  return Object.fromEntries(ids.map((id) => [id, botLlm(db, id)]))
}

/** 给同事换模型连接：connectionId = main 或 null 回到默认；model = null 用连接自己的默认模型 */
export function setBotLlm(
  db: Db, botId: string, input: { connectionId?: unknown; model?: unknown },
): { ok: true; llm: BotLlm } | { ok: false; errors: ConnectionError[] } {
  const errors: ConnectionError[] = []
  if (!db.prepare('SELECT 1 FROM bots WHERE id = ?').get(botId)) return { ok: false, errors: [{ key: 'botId', code: 'not_found' }] }
  let connection: string | null = null
  if (input.connectionId !== undefined && input.connectionId !== null && input.connectionId !== MAIN) {
    if (typeof input.connectionId !== 'string' || !getConnection(db, input.connectionId)) errors.push({ key: 'connectionId', code: 'not_found' })
    else connection = input.connectionId
  }
  let model: string | null = null
  if (input.model !== undefined && input.model !== null && input.model !== '') {
    const m = parseSetting('model', input.model)
    if (m === undefined) errors.push({ key: 'model', code: 'invalid' })
    else model = m
  }
  if (errors.length) return { ok: false, errors }
  db.prepare('UPDATE bots SET llm_connection = ?, llm_model = ? WHERE id = ?').run(connection, model, botId)
  return { ok: true, llm: botLlm(db, botId) }
}

/** 此刻这位同事该用的配置：它的连接（地址、key、接口、看图）+ 它选的模型。每次现读，改了下一次调用就用上 */
export function botConfig(startup: Config, env: Record<string, string | undefined>, db: Db, botId: string): Config {
  const choice = botLlm(db, botId)
  if (choice.connectionId === MAIN) {
    const main = currentConfig(startup, env, db)
    // 模型被环境变量锁住时，同事也不能在默认连接上换模型：环境变量说了算
    const modelLocked = lockedKeys(env).has('model')
    return choice.model && !modelLocked ? { ...main, model: choice.model } : main
  }
  const c = getConnection(db, choice.connectionId)!
  return {
    ...startup,
    baseURL: c.baseURL,
    model: choice.model ?? c.model,
    api: c.api,
    vision: c.vision,
    apiKey: readConnectionKey(startup.dataDir, c.id),
    extraBody: providerById(c.provider)?.request ?? {},
  }
}

/** 连接的 key 给界面看的样子 */
export function connectionKeyView(env: Record<string, string | undefined>, dataDir: string, id: string): { set: boolean; source: 'env' | 'file' | 'none'; key: string } {
  if (id === MAIN) {
    const k = resolveApiKey(env, dataDir)
    return { set: k.source !== 'none', source: k.source, key: k.key }
  }
  const key = readConnectionKey(dataDir, id)
  return { set: Boolean(key), source: key ? 'file' : 'none', key }
}
