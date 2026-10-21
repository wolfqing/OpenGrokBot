import { describe, expect, it } from 'vitest'
import { applyHello, applyStatus, clearDone } from './presence'

describe('presence', () => {
  it('marks a teammate done when it finishes while you look elsewhere', () => {
    expect(applyStatus({ scout: 'thinking' }, 'scout', 'idle', false)).toEqual({ scout: 'done' })
  })

  it('does not mark it done when you were watching, or when it was not working', () => {
    expect(applyStatus({ scout: 'thinking' }, 'scout', 'idle', true)).toEqual({ scout: 'idle' })
    expect(applyStatus({ scout: 'waiting' }, 'scout', 'idle', false)).toEqual({ scout: 'idle' })
    expect(applyStatus({}, 'scout', 'blocked', false)).toEqual({ scout: 'blocked' })
  })

  it('keeps done marks across a reconnect unless the gateway knows better', () => {
    expect(applyHello({ scout: 'done', ticker: 'done' }, { ticker: 'thinking' })).toEqual({ scout: 'done', ticker: 'thinking' })
  })

  it('clears done for the teammates in the thread you open', () => {
    expect(clearDone({ scout: 'done', ticker: 'done' }, ['scout'])).toEqual({ scout: 'idle', ticker: 'done' })
    const same = { scout: 'thinking' as const }
    expect(clearDone(same, ['scout'])).toBe(same)
  })
})
