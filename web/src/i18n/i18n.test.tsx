import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { en, type MessageKey } from './en'
import { I18nProvider, makeT, pickLang, translate, useT } from './index'
import { zhCN } from './zh-CN'

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('the Chinese dictionary', () => {
  it('has every key, and no key English lacks', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
  })

  it('fills in the same placeholders as English, so no value goes missing in translation', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect({ key, names: placeholders(zhCN[key]) }).toEqual({ key, names: placeholders(en[key]) })
    }
  })

  it('is actually translated: no entry is left as the English text (brand names aside)', () => {
    const sameOnPurpose = new Set<MessageKey>([
      'app.title', 'panel.trigger.webhook',
      // 品牌名、接口名和纯格式串，两种语言一样
      'models.form.apiKey', 'models.form.api.responses', 'picker.chip',
    ])
    const untranslated = (Object.keys(en) as MessageKey[]).filter((k) => !sameOnPurpose.has(k) && zhCN[k] === en[k])
    expect(untranslated).toEqual([])
  })
})

describe('translate', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate('en', 'panel.title', { name: 'Scout' })).toBe("Scout's computer")
    expect(translate('zh-CN', 'panel.title', { name: 'Scout' })).toBe('Scout 的电脑')
    expect(translate('en', 'panel.title')).toBe("{name}'s computer")
  })

  it('formats dates the browser way in English and the Chinese way in Chinese', () => {
    expect(makeT('en').locale).toBeUndefined()
    expect(makeT('zh-CN').locale).toBe('zh-CN')
  })
})

describe('pickLang', () => {
  it('follows the saved setting first', () => {
    expect(pickLang('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(pickLang('en', ['zh-CN'])).toBe('en')
  })

  it('otherwise takes the first browser language it has', () => {
    expect(pickLang('', ['zh-TW', 'en'])).toBe('zh-CN')
    expect(pickLang('', ['fr-FR', 'zh-CN'])).toBe('zh-CN')
    expect(pickLang(undefined, ['de', 'en-GB'])).toBe('en')
    expect(pickLang('', ['ja'])).toBe('en')
    expect(pickLang('', [])).toBe('en')
  })
})

describe('useT', () => {
  function Probe() {
    const t = useT()
    return <span>{t('thread.today')}</span>
  }

  it('is English without a provider, and the provider language inside one', () => {
    const { unmount } = render(<Probe />)
    expect(screen.getByText('Today')).toBeInTheDocument()
    unmount()
    render(<I18nProvider lang="zh-CN"><Probe /></I18nProvider>)
    expect(screen.getByText('今天')).toBeInTheDocument()
  })
})
