import { describe, expect, it } from 'vitest'
import { PROVIDERS, providerById } from '../src/providers.js'
import { parseSetting } from '../src/settings.js'

describe('provider presets', () => {
  it('cover the providers the wizard offers, plus a custom entry', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      'deepseek', 'kimi', 'qwen', 'glm', 'minimax-cn', 'minimax-plan-cn',
      'xai', 'openai', 'anthropic', 'gemini', 'minimax', 'minimax-plan', 'openrouter', 'ollama', 'custom',
    ])
  })

  it('only offer subscription plans whose terms allow third-party tools, and mark them', () => {
    expect(PROVIDERS.filter((p) => p.plan).map((p) => p.id)).toEqual(['minimax-plan-cn', 'minimax-plan'])
    // 条款明令不许在机器人、自动化里用的编程套餐：不做预设
    for (const host of ['coding/paas', 'api.z.ai', 'api.kimi.com/coding', 'coding.dashscope', 'coding-intl.dashscope']) {
      expect(PROVIDERS.some((p) => p.baseURL.includes(host))).toBe(false)
    }
  })

  it('speak each provider’s own API where it has one', () => {
    expect(Object.fromEntries(PROVIDERS.map((p) => [p.id, p.api]))).toMatchObject({
      anthropic: 'anthropic', openai: 'responses', xai: 'responses', gemini: 'chat', deepseek: 'chat', custom: 'chat',
    })
  })

  it('are well-formed: valid ids, https addresses (Ollama is local), a key page unless no key is needed', () => {
    for (const p of PROVIDERS) {
      expect(parseSetting('provider', p.id)).toBe(p.id)
      if (p.id === 'custom') {
        expect(p).toMatchObject({ baseURL: '', defaultModel: '', keyUrl: '' })
        continue
      }
      expect(parseSetting('baseURL', p.baseURL)).toBe(p.baseURL)
      expect(p.baseURL.startsWith(p.id === 'ollama' ? 'http://localhost:' : 'https://')).toBe(true)
      expect(parseSetting('model', p.defaultModel)).toBe(p.defaultModel)
      if (p.needsKey) expect(p.keyUrl).toMatch(/^https:\/\//)
      else expect(p.keyUrl).toBe('')
      expect(p.docsUrl).toMatch(/^https:\/\//)
      expect(p.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('never let a preset override what the gateway itself sends', () => {
    for (const p of PROVIDERS) {
      for (const k of ['model', 'messages', 'tools', 'tool_choice', 'stream']) expect(Object.hasOwn(p.request, k)).toBe(false)
    }
  })

  it('look up by id, and only known ids are a valid provider setting', () => {
    expect(providerById('deepseek')?.baseURL).toBe('https://api.deepseek.com')
    expect(providerById('nope')).toBeUndefined()
    expect(parseSetting('provider', 'nope')).toBeUndefined()
  })
})
