import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { en, type MessageKey } from './en'
import { zhCN } from './zh-CN'

export type { MessageKey }
export type Lang = 'en' | 'zh-CN'
export type Params = Record<string, string | number>

const DICTS: Record<Lang, Record<MessageKey, string>> = { en, 'zh-CN': zhCN }

/** t('panel.title', { name }) → 当前语言的文案；t.lang 是语言，t.locale 给日期数字格式化用 */
export type T = ((key: MessageKey, params?: Params) => string) & {
  lang: Lang
  /** 英文跟浏览器的地区格式（en-GB 的人看日-月）；中文固定 zh-CN */
  locale: string | undefined
}

export function translate(lang: Lang, key: MessageKey, params?: Params): string {
  const text = DICTS[lang][key] ?? en[key]
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
}

export function makeT(lang: Lang): T {
  return Object.assign((key: MessageKey, params?: Params) => translate(lang, key, params), {
    lang,
    locale: lang === 'en' ? undefined : lang,
  })
}

/** 设置里选了就听设置的；否则按浏览器的语言偏好挑第一个我们有的；都没有就英文 */
export function pickLang(setting: string | undefined, browser: readonly string[]): Lang {
  if (setting === 'en' || setting === 'zh-CN') return setting
  for (const tag of browser) {
    const t = tag.toLowerCase()
    if (t === 'zh' || t.startsWith('zh-')) return 'zh-CN'
    if (t === 'en' || t.startsWith('en-')) return 'en'
  }
  return 'en'
}

export const browserLanguages = (): readonly string[] =>
  typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]

const I18nContext = createContext<T>(makeT('en'))

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const t = useMemo(() => makeT(lang), [lang])
  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>
}

/** 没包 Provider（单个组件的测试）就是英文 */
export function useT(): T {
  return useContext(I18nContext)
}
