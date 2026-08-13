import { describe, expect, it } from 'vitest'
import { canMessage, denyReason, MAX_HOPS, parseA2AAllow } from '../src/a2a.js'

const rules = parseA2AAllow('researcher>market-watch', 'chief')

describe('parseA2AAllow', () => {
  it('reads directed pairs and ignores junk', () => {
    expect(parseA2AAllow('a>b, c>d ,,garbage,>x,y>', 'chief').pairs).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('is empty by default', () => {
    expect(parseA2AAllow('', 'chief').pairs).toEqual([])
  })
})

describe('canMessage', () => {
  it('lets the chief reach anyone and anyone reach the chief', () => {
    expect(canMessage(rules, 'chief', 'researcher')).toBe(true)
    expect(canMessage(rules, 'inbox-keeper', 'chief')).toBe(true)
  })

  it('allows only the configured peer direction', () => {
    expect(canMessage(rules, 'researcher', 'market-watch')).toBe(true)
    expect(canMessage(rules, 'market-watch', 'researcher')).toBe(false)
    expect(canMessage(rules, 'inbox-keeper', 'researcher')).toBe(false)
  })

  it('never lets a bot message itself', () => {
    expect(canMessage(rules, 'chief', 'chief')).toBe(false)
    expect(canMessage(rules, 'researcher', 'researcher')).toBe(false)
  })
})

describe('denyReason', () => {
  it('explains the allowlist to the model', () => {
    expect(denyReason(rules, 'market-watch', 'researcher')).toMatch(/not allowlisted/i)
    expect(denyReason(rules, 'researcher', 'researcher')).toMatch(/yourself/i)
  })
})

describe('MAX_HOPS', () => {
  it('keeps relays short', () => {
    expect(MAX_HOPS).toBe(2)
  })
})
