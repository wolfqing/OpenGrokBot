import { describe, expect, it } from 'vitest'
import { PROVIDERS, providerById } from '../src/providers.js'
import { parseSetting } from '../src/settings.js'

describe('provider presets', () => {
  it('cover the providers the wizard offers, plus a custom entry', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['deepseek', 'kimi', 'qwen', 'glm', 'xai', 'openai', 'openrouter', 'ollama', 'custom'])
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
