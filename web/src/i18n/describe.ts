/**
 * 把网关回来的代码说成操作者的语言。认不出的代码（更新的网关、没编码的报错）就用网关的英文原话，
 * 宁可是英文，也不显示一个键名。
 */
import type { BlockReason, NoticePayload, SandboxMissing } from '../types'
import type { MessageKey, T } from './index'
import { en } from './en'

const known = (key: string): key is MessageKey => Object.hasOwn(en, key)

export function blockReasonText(t: T, reason: BlockReason | undefined, fallback: string): string {
  if (!reason) return fallback
  const key = `block.${reason.code}`
  if (!known(key)) return fallback
  return t(key, {
    ...('target' in reason ? { target: reason.target } : {}),
    ...('max' in reason ? { max: reason.max } : {}),
  })
}

export function sandboxMissingText(t: T, code: SandboxMissing | undefined, fallback: string): string {
  if (!code) return fallback
  const key = `sandbox.${code}`
  return known(key) ? t(key) : fallback
}

/** 网关的报错：{ message, code?, params? } → 一句话 */
export function errorText(t: T, err: { message: string; code?: string | undefined; params?: Record<string, string | number> | undefined }): string {
  if (!err.code) return err.message
  const key = `error.${err.code}`
  if (!known(key)) return err.message
  const params = { ...err.params }
  // 没沙箱的原因本身也是代码
  if (err.code === 'no_sandbox') params.why = sandboxMissingText(t, params.why as SandboxMissing | undefined, '')
  return t(key, params).trim()
}

/** 网关替同事说的固定话；lead 是同事自己交代的那几行，由调用方另外显示 */
export function noticeText(t: T, n: NoticePayload): string {
  const count = (v: number) => v.toLocaleString(t.locale ?? 'en-US')
  switch (n.notice) {
    case 'stopped': return t('notice.stopped')
    case 'error': return t('notice.error', n.params)
    case 'budget': return t('notice.budget', { name: n.params.name, used: count(n.params.used), budget: count(n.params.budget) })
    case 'paused': return t(`notice.paused.${n.params.limit}`, { count: n.params.count })
  }
}

export function isNotice(payload: unknown): payload is NoticePayload {
  const n = (payload as { notice?: unknown } | null)?.notice
  return n === 'stopped' || n === 'error' || n === 'budget' || n === 'paused'
}

/**
 * cron 的人话。只认常见形态（和网关 describeCron 一样）；认不出就给原始表达式，好过编一句错的。
 * 星期几用浏览器的日期格式说，不进词典。
 */
export function describeSchedule(t: T, cron: string, webhook: boolean): string {
  const parts = [cron.trim() ? describeCron(t, cron) : '', webhook ? t('cron.webhook') : ''].filter(Boolean)
  if (parts.length === 2) return t('cron.and', { first: parts[0]!, second: parts[1]! })
  return parts[0] ?? t('cron.never')
}

function describeCron(t: T, expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string]
  if (expr.trim() === '* * * * *') return t('cron.everyMinute')
  const everyN = min.match(/^\*\/(\d+)$/)
  if (everyN && hour === '*' && dom === '*' && month === '*' && dow === '*') return t('cron.everyMinutes', { count: everyN[1]! })
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && month === '*') {
    const at = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    if (dom === '*' && dow === '*') return t('cron.daily', { at })
    if (dom === '*' && /^[0-6]$/.test(dow)) return t('cron.weekly', { day: weekday(t, Number(dow)), at })
    if (/^\d+$/.test(dom) && dow === '*') return t('cron.monthly', { day: dom, at })
  }
  return expr
}

/** 2023-01-01 是星期日：往后数 dow 天 */
const weekday = (t: T, dow: number) =>
  new Date(2023, 0, 1 + dow).toLocaleDateString(t.lang === 'en' ? 'en-US' : t.lang, { weekday: 'long' })
