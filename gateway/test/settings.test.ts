import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { openDb } from '../src/db.js'
import {
  SETTING_DEFAULTS, applySettings, currentConfig, needsSetup, readApiKey, readSavedSettings, resolveApiKey, resolveSettings, saveApiKey, saveSettings,
} from '../src/settings.js'

describe('settings', () => {
  it('starts from defaults that match what the gateway uses without any env', () => {
    const c = loadConfig({})
    const { values, sources } = resolveSettings({}, {})
    expect(values).toEqual(SETTING_DEFAULTS)
    expect(values).toMatchObject({
      baseURL: c.baseURL, model: c.model, vision: c.vision, computers: c.computers, browserMirror: c.browserMirror,
    })
    expect(Object.values(sources).every((s) => s === 'default')).toBe(true)
  })

  it('stores what the operator saves and reads it back', () => {
    const db = openDb(':memory:')
    expect(readSavedSettings(db)).toEqual({})
    const saved = saveSettings(db, {
      provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', vision: false,
      language: 'zh-CN', computers: 'local', browserMirror: 'https://cdn.npmmirror.com/binaries/playwright', checkUpdates: false,
    })
    expect(saved).toEqual({ ok: true })
    expect(readSavedSettings(db)).toEqual({
      provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', vision: false,
      language: 'zh-CN', computers: 'local', browserMirror: 'https://cdn.npmmirror.com/binaries/playwright', checkUpdates: false,
    })
    const { values, sources } = resolveSettings({}, readSavedSettings(db))
    expect(values.model).toBe('deepseek-chat')
    expect(sources.model).toBe('saved')
    expect(sources.vision).toBe('saved')
  })

  it('lets null put a setting back to its default', () => {
    const db = openDb(':memory:')
    saveSettings(db, { model: 'deepseek-chat', language: 'en' })
    expect(saveSettings(db, { model: null })).toEqual({ ok: true })
    expect(readSavedSettings(db)).toEqual({ language: 'en' })
    expect(resolveSettings({}, readSavedSettings(db)).sources.model).toBe('default')
  })

  it('refuses unknown keys and bad values, and then saves nothing at all', () => {
    const db = openDb(':memory:')
    const result = saveSettings(db, {
      model: 'deepseek-chat', apiKey: 'sk-x', baseURL: 'file:///etc/passwd', vision: 'yes', language: 'fr',
      computers: 'cloud', browserMirror: 'ftp://mirror', provider: 'Deep Seek!', checkUpdates: 1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.fromEntries(result.errors.map((e) => [e.key, e.code]))).toEqual({
      apiKey: 'unknown_setting', baseURL: 'invalid', vision: 'invalid', language: 'invalid', computers: 'invalid',
      browserMirror: 'invalid', provider: 'invalid', checkUpdates: 'invalid',
    })
    expect(readSavedSettings(db)).toEqual({})
    for (const model of ['', '   ', 'a\nb', 'x'.repeat(201)]) expect(saveSettings(db, { model }).ok).toBe(false)
    expect(saveSettings(db, { model: '  qwen-plus  ' })).toEqual({ ok: true })
    expect(readSavedSettings(db).model).toBe('qwen-plus')
    expect(saveSettings(db, { browserMirror: '' })).toEqual({ ok: true }) // 明确选官方源
  })

  it('skips rows it cannot make sense of instead of failing to start', () => {
    const db = openDb(':memory:')
    const put = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)')
    put.run('model', '"grok-4-fast"')
    put.run('vision', 'not json')
    put.run('computers', '"cloud"')
    put.run('fromANewerBuild', '"whatever"')
    expect(readSavedSettings(db)).toEqual({ model: 'grok-4-fast' })
  })

  it('lets env vars win, and says so', () => {
    const env = {
      OPENSUPERBOT_API_BASE: 'http://localhost:11434/v1', OPENSUPERBOT_MODEL: 'qwen3', OPENSUPERBOT_VISION: '0',
      OPENSUPERBOT_COMPUTERS: 'docker', OPENSUPERBOT_BROWSER_MIRROR: ' ',
    }
    const { values, sources } = resolveSettings(env, { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', vision: true, computers: 'local' })
    expect(values).toMatchObject({ baseURL: 'http://localhost:11434/v1', model: 'qwen3', vision: false, computers: 'docker' })
    expect(sources).toMatchObject({ baseURL: 'env', model: 'env', vision: 'env', computers: 'env' })
    expect(sources.browserMirror).toBe('default') // 空白不算设了
    expect(sources.language).toBe('default') // 没有对应的环境变量
  })

  it('lays the resolved settings over the startup config', () => {
    const config = loadConfig({ OPENSUPERBOT_DATA: '/tmp/ogb-x' })
    const merged = applySettings(config, resolveSettings({}, { model: 'deepseek-chat', computers: 'local' }).values, 'sk-file')
    expect(merged).toMatchObject({ model: 'deepseek-chat', computers: 'local', apiKey: 'sk-file', dataDir: '/tmp/ogb-x', port: 4747 })
    expect(config.model).toBe('grok-4.7') // 原来的不动
  })
})

describe('the API key file', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ogb-key-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps the key in <data>/llm-key, readable only by you', () => {
    expect(readApiKey(dir)).toBe('')
    expect(saveApiKey(dir, '  sk-abc123  ')).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'llm-key'), 'utf8')).toBe('sk-abc123\n')
    expect(statSync(join(dir, 'llm-key')).mode & 0o777).toBe(0o600)
    expect(readApiKey(dir)).toBe('sk-abc123')
  })

  it('tightens a key file someone loosened, and creates the data dir if needed', () => {
    const nested = join(dir, 'fresh')
    saveApiKey(nested, 'sk-1')
    chmodSync(join(nested, 'llm-key'), 0o644)
    saveApiKey(nested, 'sk-2')
    expect(statSync(join(nested, 'llm-key')).mode & 0o777).toBe(0o600)
    expect(readApiKey(nested)).toBe('sk-2')
  })

  it('removes the file when the key is cleared', () => {
    saveApiKey(dir, 'sk-abc')
    expect(saveApiKey(dir, '')).toEqual({ ok: true })
    expect(existsSync(join(dir, 'llm-key'))).toBe(false)
    expect(saveApiKey(dir, '')).toEqual({ ok: true }) // 本来就没有也不报错
  })

  it('refuses a key that would break the Authorization header', () => {
    for (const bad of ['sk a', 'sk\nInjected: 1', 'sk\u0000', 'x'.repeat(4097)]) {
      expect(saveApiKey(dir, bad)).toEqual({ ok: false, code: 'invalid' })
    }
    expect(existsSync(join(dir, 'llm-key'))).toBe(false)
  })

  it('prefers the env var over the file, and says where the key came from', () => {
    saveApiKey(dir, 'sk-file')
    expect(resolveApiKey({ OPENSUPERBOT_API_KEY: 'sk-env' }, dir)).toEqual({ key: 'sk-env', source: 'env' })
    expect(resolveApiKey({}, dir)).toEqual({ key: 'sk-file', source: 'file' })
    saveApiKey(dir, '')
    expect(resolveApiKey({}, dir)).toEqual({ key: '', source: 'none' })
  })
})

describe('currentConfig', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ogb-live-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sees a saved setting and a new key file right away, and env vars still win', () => {
    const db = openDb(':memory:')
    const startup = loadConfig({ OPENSUPERBOT_DATA: dir })
    expect(currentConfig(startup, {}, db)).toMatchObject({ model: 'grok-4.7', apiKey: '', vision: false })
    saveSettings(db, { model: 'deepseek-chat', vision: true })
    saveApiKey(dir, 'sk-file')
    expect(currentConfig(startup, {}, db)).toMatchObject({ model: 'deepseek-chat', apiKey: 'sk-file', vision: true, dataDir: dir })
    expect(currentConfig(startup, { OPENSUPERBOT_MODEL: 'qwen3', OPENSUPERBOT_API_KEY: 'sk-env' }, db))
      .toMatchObject({ model: 'qwen3', apiKey: 'sk-env', vision: true })
  })
})

describe('the chosen provider', () => {
  it('brings its request fields along, and nothing when none is chosen', () => {
    const db = openDb(':memory:')
    const startup = loadConfig({ OPENSUPERBOT_DATA: '/tmp/ogb-none' })
    expect(currentConfig(startup, {}, db).extraBody).toEqual({})
    saveSettings(db, { provider: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-6-luna' })
    expect(currentConfig(startup, {}, db).extraBody).toEqual({ reasoning_effort: 'none' })
  })
})

describe('needsSetup', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ogb-setup-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is true on a fresh install, and false once there is a key, a keyless provider or the demo', () => {
    const db = openDb(':memory:')
    expect(needsSetup({}, db, dir)).toBe(true)
    saveSettings(db, { provider: 'deepseek' }) // 选了服务商、还没粘 key
    expect(needsSetup({}, db, dir)).toBe(true)
    saveApiKey(dir, 'sk-abc')
    expect(needsSetup({}, db, dir)).toBe(false)
    saveApiKey(dir, '')
    saveSettings(db, { provider: 'ollama' })
    expect(needsSetup({}, db, dir)).toBe(false)
    saveSettings(db, { provider: null, model: 'stub' })
    expect(needsSetup({}, db, dir)).toBe(false)
  })

  it('stays out of the way of anyone who configured the model with env vars', () => {
    const db = openDb(':memory:')
    for (const env of [{ OPENSUPERBOT_API_KEY: 'sk-x' }, { OPENSUPERBOT_MODEL: 'stub' }, { OPENSUPERBOT_API_BASE: 'http://localhost:11434/v1' }]) {
      expect(needsSetup(env, db, dir)).toBe(false)
    }
  })
})
