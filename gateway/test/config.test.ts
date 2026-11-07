import { basename, isAbsolute, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adoptLegacyEnv, defaultDbPath, loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('applies xAI defaults', () => {
    const c = loadConfig({})
    expect(c.baseURL).toBe('https://api.x.ai/v1')
    expect(c.model).toBe('grok-4.7')
    expect(c.port).toBe(4747)
    expect(c.apiKey).toBe('')
    expect(c.chiefId).toBe('chief')
    expect(c.a2aAllow).toBe('') // 同级互发默认关闭
    expect(c.groupId).toBe('group:offsite-crew')
  })

  it('honors env overrides', () => {
    const c = loadConfig({
      OPENSUPERBOT_API_BASE: 'http://localhost:11434/v1',
      OPENSUPERBOT_API_KEY: 'sk-test',
      OPENSUPERBOT_MODEL: 'qwen3',
      OPENSUPERBOT_PORT: '5050',
      OPENSUPERBOT_DATA: '/tmp/data',
      OPENSUPERBOT_DB: '/tmp/x.db',
      OPENSUPERBOT_TEAMMATES: '/tmp/teammates',
    })
    expect(c).toMatchObject({
      baseURL: 'http://localhost:11434/v1', apiKey: 'sk-test', model: 'qwen3',
      port: 5050, dataDir: resolve('/tmp/data'), dbPath: resolve('/tmp/x.db'), teammatesDir: '/tmp/teammates',
    })
  })

  it('defaults to a loopback-only, token-guarded gateway with sane budgets', () => {
    const c = loadConfig({})
    expect(c.host).toBe('127.0.0.1')
    expect(c.token).toBe('')
    expect(c.allowedOrigins).toEqual([])
    expect(c.llmTimeoutMs).toBe(120_000)
    expect(c.llmRetries).toBe(2)
    expect(c.dailyTokens).toBe(0)
    expect(c.vision).toBe(false)
    expect(c.idleStopMinutes).toBe(60)
    expect(c.botMemoryMb).toBe(2048)
    expect(c.botCpus).toBe(2)
    expect(c.timeZone).toBeTruthy()
    expect(c.maxSteps).toBe(40)
    expect(c.turnMinutes).toBe(20)
  })

  it('reads the per-turn limits, and never lets the step cap be zero', () => {
    expect(loadConfig({ OPENSUPERBOT_MAX_STEPS: '60', OPENSUPERBOT_TURN_MINUTES: '0' }))
      .toMatchObject({ maxSteps: 60, turnMinutes: 0 })
    expect(loadConfig({ OPENSUPERBOT_MAX_STEPS: '0' }).maxSteps).toBe(40)
  })

  it('reads the new knobs from the environment', () => {
    const c = loadConfig({
      OPENSUPERBOT_HOST: '0.0.0.0',
      OPENSUPERBOT_TOKEN: 'fixed',
      OPENSUPERBOT_ALLOWED_ORIGINS: 'https://bots.example.com, http://mini.local:4747',
      OPENSUPERBOT_LLM_TIMEOUT_MS: '30000',
      OPENSUPERBOT_LLM_RETRIES: '0',
      OPENSUPERBOT_DAILY_TOKENS: '200000',
      OPENSUPERBOT_VISION: '1',
      OPENSUPERBOT_IDLE_STOP_MINUTES: '0',
      OPENSUPERBOT_BOT_MEMORY_MB: '1024',
      OPENSUPERBOT_BOT_CPUS: '1.5',
      OPENSUPERBOT_WEB_URL: 'http://localhost:5173',
      TZ: 'Europe/Berlin',
    })
    expect(c).toMatchObject({
      host: '0.0.0.0', token: 'fixed',
      allowedOrigins: ['https://bots.example.com', 'http://mini.local:4747'],
      llmTimeoutMs: 30_000, llmRetries: 0, dailyTokens: 200_000, vision: true,
      idleStopMinutes: 0, botMemoryMb: 1024, botCpus: 1.5, webUrl: 'http://localhost:5173',
      timeZone: 'Europe/Berlin',
    })
  })

  it('turns a relative data dir into an absolute one (docker would read it as a volume name)', () => {
    const c = loadConfig({ OPENSUPERBOT_DATA: 'data-stub' })
    expect(isAbsolute(c.dataDir)).toBe(true)
    expect(basename(c.dataDir)).toBe('data-stub')
    expect(isAbsolute(c.dbPath)).toBe(true)
  })

  it('defaults the db inside the data dir', () => {
    expect(loadConfig({ OPENSUPERBOT_DATA: '/tmp/data' }).dbPath).toBe(join(resolve('/tmp/data'), 'opensuperbot.db'))
  })
})

describe('settings from before the rename (OpenGrokBot)', () => {
  it('still honours OPENGROKBOT_* when the new name is unset, and the new name wins when both are set', () => {
    const env: Record<string, string | undefined> = {
      OPENGROKBOT_API_KEY: 'sk-old', OPENGROKBOT_MODEL: 'grok-old', OPENSUPERBOT_MODEL: 'qwen3', HOME: '/home/op',
    }
    expect(adoptLegacyEnv(env)).toEqual({ adopted: ['OPENGROKBOT_API_KEY'], shadowed: ['OPENGROKBOT_MODEL'] })
    expect(loadConfig(env)).toMatchObject({ apiKey: 'sk-old', model: 'qwen3' })
    expect(adoptLegacyEnv({ OPENSUPERBOT_PORT: '5050' })).toEqual({ adopted: [], shadowed: [] })
  })

  it('keeps using opengrokbot.db when an old data dir has only that file', () => {
    const has = (...names: string[]) => (path: string) => names.some((n) => path === join('/data', n))
    expect(defaultDbPath('/data', has('opengrokbot.db'))).toBe(join('/data', 'opengrokbot.db'))
    expect(defaultDbPath('/data', has('opengrokbot.db', 'opensuperbot.db'))).toBe(join('/data', 'opensuperbot.db'))
    expect(defaultDbPath('/data', has())).toBe(join('/data', 'opensuperbot.db'))
  })
})
