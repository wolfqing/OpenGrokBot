import type { Hono } from 'hono'
import type { Config } from './config.js'
import type { Db } from './db.js'
import { checkConnection, listModels } from './llm-check.js'
import {
  checkSettings, currentConfig, lockedKeys, maskKey, parseSetting, readSavedSettings, resolveApiKey, resolveSettings,
  saveApiKey, saveSettings, validApiKey, type SettingError, type SettingKey,
} from './settings.js'

export type SettingsDeps = {
  /** 网关进程的环境变量：设了的项在界面上锁定 */
  env: Record<string, string | undefined>
  /** 网关启动时生效的配置：用来判断哪些改动要重启才算数 */
  startedWith: Config
  fetchImpl?: typeof fetch
}

/** 只在启动时读一次的设置，改了要重启网关 */
const RESTART_KEYS = ['computers', 'browserMirror'] as const

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function mountSettings(app: Hono, deps: SettingsDeps & { db: Db }): void {
  const { db, env, startedWith } = deps
  const dataDir = startedWith.dataDir
  const now = () => currentConfig(startedWith, env, db)

  /** key 只回掩码和来源，原文从不离开网关 */
  const view = () => {
    const { values, sources } = resolveSettings(env, readSavedSettings(db))
    const key = resolveApiKey(env, dataDir)
    return {
      values,
      sources,
      apiKey: { set: key.source !== 'none', masked: maskKey(key.key), source: key.source },
      needsRestart: RESTART_KEYS.filter((k) => values[k] !== startedWith[k]),
    }
  }

  app.get('/api/settings', (c) => c.json(view()))

  app.put('/api/settings', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) return c.json({ error: 'invalid_settings', errors: [{ key: '', code: 'invalid' }] }, 400)
    const { apiKey, ...patch } = body
    const locked = lockedKeys(env)
    const errors: SettingError[] = Object.keys(patch)
      .filter((k) => locked.has(k as SettingKey))
      .map((key) => ({ key, code: 'locked' as const }))
    if (apiKey !== undefined) {
      if (locked.has('apiKey')) errors.push({ key: 'apiKey', code: 'locked' })
      else if (apiKey !== null && (typeof apiKey !== 'string' || (apiKey.trim() !== '' && !validApiKey(apiKey.trim())))) {
        errors.push({ key: 'apiKey', code: 'invalid' })
      }
    }
    errors.push(...checkSettings(patch).errors.filter((e) => !locked.has(e.key as SettingKey)))
    if (errors.length) return c.json({ error: 'invalid_settings', errors }, 400)
    saveSettings(db, patch)
    if (apiKey !== undefined) saveApiKey(dataDir, typeof apiKey === 'string' ? apiKey : '')
    return c.json(view())
  })

  // 向导里粘了 key 还没存时先试：没给 key 时只有地址没换才用存着的 key——绝不把一家的 key 发给另一家
  app.post('/api/settings/test', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!isObject(body)) return c.json({ error: 'invalid_settings', errors: [{ key: '', code: 'invalid' }] }, 400)
    const current = now()
    const errors: SettingError[] = []
    const pick = <K extends 'baseURL' | 'model'>(key: K): string => {
      if (body[key] === undefined) return current[key]
      const v = parseSetting(key, body[key])
      if (v === undefined) errors.push({ key, code: 'invalid' })
      return v ?? ''
    }
    const baseURL = pick('baseURL')
    const model = pick('model')
    let apiKey = baseURL === current.baseURL ? current.apiKey : ''
    if (body.apiKey !== undefined) {
      const k = typeof body.apiKey === 'string' ? body.apiKey.trim() : null
      if (k === null || (k !== '' && !validApiKey(k))) errors.push({ key: 'apiKey', code: 'invalid' })
      else apiKey = k
    }
    if (errors.length) return c.json({ error: 'invalid_settings', errors }, 400)
    return c.json(await checkConnection({ baseURL, apiKey, model }, { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }))
  })

  app.get('/api/settings/models', async (c) => {
    const { baseURL, apiKey } = now()
    return c.json(await listModels({ baseURL, apiKey }, { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }))
  })
}
