import type { Hono } from 'hono'
import type { Config, LlmApi } from './config.js'
import {
  MAIN, connectionKeyView, createConnection, deleteConnection, getConnection, isConnectionId, listBotLlms, listConnections,
  mainConnection, parseKey, readConnectionKey, resetBotModels, setBotLlm, updateConnection, type Connection, type ConnectionError, type ConnectionInput,
} from './connections.js'
import type { Db } from './db.js'
import { checkConnection, listModels } from './llm-check.js'
import { providerById } from './providers.js'
import { lockedKeys, maskKey, parseSetting, saveApiKey, saveSettings, type SettingKey } from './settings.js'

export type ConnectionsDeps = {
  db: Db
  env: Record<string, string | undefined>
  startedWith: Config
  fetchImpl?: typeof fetch
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = (errors: ConnectionError[]) => ({ error: 'invalid_connection', errors })

/**
 * 默认连接上被环境变量定死的字段。地址或 key 被定死，服务商和地址就都不能在界面上换：
 * 环境变量里的 key 是给那一家的，换了地方它也会跟过去
 */
export function mainLocks(env: Record<string, string | undefined>): string[] {
  const locked = lockedKeys(env)
  const out: string[] = (['baseURL', 'model', 'vision', 'apiKey'] as const).filter((k) => locked.has(k))
  return locked.has('baseURL') || locked.has('apiKey') ? ['provider', ...new Set(['baseURL', ...out])] : out
}

export function mountConnections(app: Hono, deps: ConnectionsDeps): void {
  const { db, env, startedWith } = deps
  const dataDir = startedWith.dataDir
  const fetchOpts = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}

  /** key 只回掩码和来源，原文从不离开网关 */
  const view = (c: Connection) => {
    const key = connectionKeyView(env, dataDir, c.id)
    return {
      id: c.id, name: c.name, provider: c.provider, api: c.api, baseURL: c.baseURL, model: c.model, vision: c.vision,
      builtIn: c.id === MAIN,
      key: { set: key.set, masked: maskKey(key.key), source: key.source },
      locked: c.id === MAIN ? mainLocks(env) : [],
    }
  }
  const all = () => ({
    connections: [mainConnection(startedWith, env, db), ...listConnections(db)].map(view),
    bots: listBotLlms(db),
  })
  /** 连接此刻的完整样子（含 key 原文），只在网关里用 */
  const resolved = (id: string) => {
    if (id === MAIN) {
      const m = mainConnection(startedWith, env, db)
      return { ...m, apiKey: m.config.apiKey, extraBody: m.config.extraBody }
    }
    const c = getConnection(db, id)
    return c ? { ...c, apiKey: readConnectionKey(dataDir, id), extraBody: providerById(c.provider)?.request ?? {} } : undefined
  }

  app.get('/api/connections', (c) => c.json(all()))

  app.post('/api/connections', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) return c.json(bad([{ key: '', code: 'invalid' }]), 400)
    const made = createConnection(db, dataDir, body as ConnectionInput)
    if (!made.ok) return c.json(bad(made.errors), 400)
    return c.json({ ...all(), created: made.connection.id }, 201)
  })

  app.patch('/api/connections/:id', async (c) => {
    const id = c.req.param('id')
    if (!isConnectionId(id)) return c.json(bad([{ key: 'id', code: 'not_found' }]), 404)
    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) return c.json(bad([{ key: '', code: 'invalid' }]), 400)
    if (id !== MAIN) {
      const done = updateConnection(db, dataDir, id, body as ConnectionInput)
      if (!done.ok) return c.json(bad(done.errors), done.errors.some((e) => e.code === 'not_found') ? 404 : 400)
      return c.json(all())
    }
    // 默认连接就是设置里那一套：照设置的规矩存（环境变量锁住的不许改）
    const locks = new Set(mainLocks(env))
    const errors: ConnectionError[] = []
    for (const k of ['provider', 'baseURL', 'model', 'vision', 'apiKey']) {
      if (body[k] !== undefined && locks.has(k)) errors.push({ key: k, code: 'locked' })
    }
    const key = parseKey(body.apiKey, errors)
    const patch: Partial<Record<SettingKey, unknown>> = {}
    const before = mainConnection(startedWith, env, db)
    if (body.provider !== undefined) {
      const p = parseSetting('provider', body.provider)
      if (p === undefined) errors.push({ key: 'provider', code: 'invalid' })
      else {
        patch.provider = p
        // 换了服务商又没说地址和模型：用那家预设的（环境变量定死的不动，存了也是暗中等着生效）
        const preset = providerById(p)
        if (p !== before.provider && preset) {
          if (body.baseURL === undefined && preset.baseURL && !locks.has('baseURL')) patch.baseURL = preset.baseURL
          if (body.model === undefined && preset.defaultModel && !locks.has('model')) patch.model = preset.defaultModel
          if (body.vision === undefined && !locks.has('vision')) patch.vision = preset.vision
        }
      }
    }
    for (const k of ['baseURL', 'model', 'vision'] as const) {
      if (body[k] === undefined) continue
      const v = parseSetting(k, body[k])
      if (v === undefined) errors.push({ key: k, code: 'invalid' })
      else patch[k] = v
    }
    if (errors.length) return c.json(bad(errors), 400)
    if (Object.keys(patch).length) saveSettings(db, patch)
    const after = mainConnection(startedWith, env, db)
    if (key !== undefined) saveApiKey(dataDir, key)
    else if (after.baseURL !== before.baseURL) saveApiKey(dataDir, '') // 绝不把一家的 key 发给另一家（key 被锁时地址也锁着，到不了这里）
    if (after.provider !== before.provider || after.api !== before.api || after.baseURL !== before.baseURL) resetBotModels(db, MAIN)
    return c.json(all())
  })

  app.delete('/api/connections/:id', (c) => {
    const id = c.req.param('id')
    if (id === MAIN) return c.json(bad([{ key: 'id', code: 'in_use' }]), 409)
    if (!isConnectionId(id)) return c.json(bad([{ key: 'id', code: 'not_found' }]), 404)
    const done = deleteConnection(db, dataDir, id)
    if (!done.ok) return c.json(bad(done.errors), 404)
    return c.json({ ...all(), moved: done.moved })
  })

  /**
   * 测连接：可以测一个存着的连接，也可以测还没存的（向导里、编辑框里粘了 key 还没点保存）。
   * 没给 key 时，只有地址没换才用存着的 key——绝不把一家的 key 发给另一家。
   */
  app.post('/api/connections/test', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) return c.json(bad([{ key: '', code: 'invalid' }]), 400)
    const errors: ConnectionError[] = []
    let start: { id?: string; provider: string; api: LlmApi; baseURL: string; model: string; apiKey: string; extraBody: Record<string, unknown> } =
      { provider: 'custom', api: 'chat', baseURL: '', model: '', apiKey: '', extraBody: {} }
    if (body.connectionId !== undefined) {
      const found = typeof body.connectionId === 'string' && isConnectionId(body.connectionId) ? resolved(body.connectionId) : undefined
      if (!found) return c.json(bad([{ key: 'connectionId', code: 'not_found' }]), 404)
      start = found
    }
    let provider = start.provider
    if (body.provider !== undefined) {
      if (typeof body.provider !== 'string' || !providerById(body.provider)) errors.push({ key: 'provider', code: 'invalid' })
      else provider = body.provider
    }
    const preset = providerById(provider)
    const switched = provider !== start.provider
    const pick = (k: 'baseURL' | 'model', fallback: string): string => {
      if (body[k] === undefined) return fallback
      const v = parseSetting(k, body[k])
      if (v === undefined) errors.push({ key: k, code: 'invalid' })
      return v ?? ''
    }
    const baseURL = pick('baseURL', switched ? preset?.baseURL ?? '' : start.baseURL)
    const model = pick('model', switched ? preset?.defaultModel ?? '' : start.model)
    // 服务商没换：照它此刻运行时的接口和请求字段测（默认连接按地址认出的服务商，运行时可能还是 OpenAI 兼容口），
    // 测出来的才和同事真正发的一样；换了才用那家预设的
    let api: LlmApi = switched && preset && preset.id !== 'custom' ? preset.api : start.api
    const extraBody = switched ? preset?.request ?? {} : start.extraBody
    if (body.api !== undefined) {
      if (body.api !== 'chat' && body.api !== 'anthropic' && body.api !== 'responses') errors.push({ key: 'api', code: 'invalid' })
      // 默认连接存不了接口（只由服务商推出），自定义的另加连接才能选
      else if ((!preset || preset.id === 'custom') && start.id !== MAIN) api = body.api
    }
    const typed = parseKey(body.apiKey, errors)
    const apiKey = typed ?? (baseURL === start.baseURL ? start.apiKey : '')
    if (!baseURL) errors.push({ key: 'baseURL', code: 'required' })
    if (!model) errors.push({ key: 'model', code: 'required' })
    if (errors.length) return c.json(bad(errors), 400)
    return c.json(await checkConnection({ baseURL, apiKey, model, api, extraBody }, fetchOpts))
  })

  app.get('/api/connections/:id/models', async (c) => {
    const id = c.req.param('id')
    const found = isConnectionId(id) ? resolved(id) : undefined
    if (!found) return c.json(bad([{ key: 'id', code: 'not_found' }]), 404)
    return c.json(await listModels({ baseURL: found.baseURL, apiKey: found.apiKey, api: found.api }, fetchOpts))
  })

  app.put('/api/bots/:botId/llm', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) return c.json(bad([{ key: '', code: 'invalid' }]), 400)
    const done = setBotLlm(db, c.req.param('botId'), body)
    if (!done.ok) return c.json(bad(done.errors), done.errors.some((e) => e.key === 'botId') ? 404 : 400)
    return c.json(done.llm)
  })
}
