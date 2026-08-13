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

  it('defaults the db inside the data dir', () => {
    expect(loadConfig({ OPENGROKBOT_DATA: '/tmp/data' }).dbPath).toBe('/tmp/data/opengrokbot.db')
  })
})
