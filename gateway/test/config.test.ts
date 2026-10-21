import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('applies xAI defaults', () => {
    const c = loadConfig({})
    expect(c.baseURL).toBe('https://api.x.ai/v1')
    expect(c.model).toBe('grok-4')
    expect(c.port).toBe(4747)
    expect(c.apiKey).toBe('')
    expect(c.chiefId).toBe('chief')
    expect(c.a2aAllow).toBe('') // 同级互发默认关闭
    expect(c.groupId).toBe('group:offsite-crew')
  })

  it('honors env overrides', () => {
    const c = loadConfig({
      OPENGROKBOT_API_BASE: 'http://localhost:11434/v1',
      OPENGROKBOT_API_KEY: 'sk-test',
      OPENGROKBOT_MODEL: 'qwen3',
      OPENGROKBOT_PORT: '5050',
      OPENGROKBOT_DATA: '/tmp/data',
      OPENGROKBOT_DB: '/tmp/x.db',
      OPENGROKBOT_TEAMMATES: '/tmp/teammates',
    })
    expect(c).toMatchObject({
      baseURL: 'http://localhost:11434/v1', apiKey: 'sk-test', model: 'qwen3',
      port: 5050, dataDir: '/tmp/data', dbPath: '/tmp/x.db', teammatesDir: '/tmp/teammates',
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
    expect(loadConfig({ OPENGROKBOT_MAX_STEPS: '60', OPENGROKBOT_TURN_MINUTES: '0' }))
      .toMatchObject({ maxSteps: 60, turnMinutes: 0 })
    expect(loadConfig({ OPENGROKBOT_MAX_STEPS: '0' }).maxSteps).toBe(40)
  })

  it('reads the new knobs from the environment', () => {
    const c = loadConfig({
      OPENGROKBOT_HOST: '0.0.0.0',
      OPENGROKBOT_TOKEN: 'fixed',
      OPENGROKBOT_ALLOWED_ORIGINS: 'https://bots.example.com, http://mini.local:4747',
      OPENGROKBOT_LLM_TIMEOUT_MS: '30000',
      OPENGROKBOT_LLM_RETRIES: '0',
      OPENGROKBOT_DAILY_TOKENS: '200000',
      OPENGROKBOT_VISION: '1',
      OPENGROKBOT_IDLE_STOP_MINUTES: '0',
      OPENGROKBOT_BOT_MEMORY_MB: '1024',
      OPENGROKBOT_BOT_CPUS: '1.5',
      OPENGROKBOT_WEB_URL: 'http://localhost:5173',
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
    const c = loadConfig({ OPENGROKBOT_DATA: 'data-stub' })
    expect(isAbsolute(c.dataDir)).toBe(true)
    expect(c.dataDir.endsWith('/data-stub')).toBe(true)
    expect(isAbsolute(c.dbPath)).toBe(true)
  })

  it('defaults the db inside the data dir', () => {
    expect(loadConfig({ OPENGROKBOT_DATA: '/tmp/data' }).dbPath).toBe('/tmp/data/opengrokbot.db')
  })
})
