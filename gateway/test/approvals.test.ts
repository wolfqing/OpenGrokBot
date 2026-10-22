import { describe, expect, it } from 'vitest'
import {
  attachApprovalMessage, canRemember, createApproval, createRule, destinationProblem, findMatchingRule, getApproval,
  isThumbsUp, latestPendingApproval, listActiveRules, normalizeKind, normalizeTarget, rememberBlock, resolveApproval,
  revokeRule,
} from '../src/approvals.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'

const bot = { id: 'inbox-keeper', name: 'Sorter', role: 'inbox', emoji: '📥', soul_path: '' }

function setup() {
  const db = openDb(':memory:')
  upsertBot(db, bot)
  const threadId = ensureDmThread(db, bot.id)
  return { db, threadId }
}

describe('approvals', () => {
  it('creates a pending approval and finds it by thread', () => {
    const { db, threadId } = setup()
    const a = createApproval(db, { threadId, botId: bot.id, action: 'send 4 drafts', detail: 'to the Globex thread' })
    expect(a).toMatchObject({ status: 'pending', action: 'send 4 drafts', detail: 'to the Globex thread' })
    expect(latestPendingApproval(db, threadId)!.id).toBe(a.id)
  })

  it('resolves once and is idempotent afterwards', () => {
    const { db, threadId } = setup()
    const a = createApproval(db, { threadId, botId: bot.id, action: 'send it', detail: '' })
    const resolved = resolveApproval(db, a.id, 'approve')!
    expect(resolved.status).toBe('approved')
    expect(resolved.resolved_at).toBeGreaterThan(0)
    expect(resolveApproval(db, a.id, 'discard')).toBeNull() // 二次点击不再改状态
    expect(getApproval(db, a.id)!.status).toBe('approved')
    expect(latestPendingApproval(db, threadId)).toBeNull()
  })

  it('records a discard', () => {
    const { db, threadId } = setup()
    const a = createApproval(db, { threadId, botId: bot.id, action: 'send it', detail: '' })
    expect(resolveApproval(db, a.id, 'discard')!.status).toBe('discarded')
  })

  it('remembers which message carries the chip', () => {
    const { db, threadId } = setup()
    const a = createApproval(db, { threadId, botId: bot.id, action: 'send it', detail: '' })
    attachApprovalMessage(db, a.id, 42)
    expect(getApproval(db, a.id)!.message_id).toBe(42)
  })

  it('returns the newest pending approval when several are open', () => {
    const { db, threadId } = setup()
    createApproval(db, { threadId, botId: bot.id, action: 'first', detail: '' })
    const second = createApproval(db, { threadId, botId: bot.id, action: 'second', detail: '' })
    expect(latestPendingApproval(db, threadId)!.id).toBe(second.id)
  })

  it('returns null for an unknown approval', () => {
    const { db } = setup()
    expect(getApproval(db, 999)).toBeNull()
    expect(resolveApproval(db, 999, 'approve')).toBeNull()
  })
})

describe('isThumbsUp', () => {
  it('accepts a bare thumbs up with skin tones, variation selectors and spaces', () => {
    for (const text of ['👍', ' 👍 ', '👍🏽', '👍️', '👍🏻 ']) expect(isThumbsUp(text)).toBe(true)
  })

  it('rejects anything with words or other emoji', () => {
    for (const text of ['👍 send it', 'ok', '👎', '', '👍👍']) expect(isThumbsUp(text)).toBe(false)
  })
})

describe('approval kinds and targets', () => {
  it('treats anything it does not recognise as "other"', () => {
    expect(normalizeKind('EMAIL')).toBe('email')
    expect(normalizeKind('wire transfer')).toBe('other')
    expect(normalizeKind(undefined)).toBe('other')
  })

  it('compares destinations without case or stray spaces', () => {
    expect(normalizeTarget('  Bob@Acme.COM ')).toBe('bob@acme.com')
    expect(normalizeTarget('#ops   alerts')).toBe('#ops alerts')
  })

  it('only lets messages to one destination become standing rules', () => {
    expect(canRemember({ kind: 'email', target: 'bob@acme.com' })).toBe(true)
    expect(canRemember({ kind: 'email', target: '' })).toBe(false) // 没有去向 = 这一类全放，不行
    expect(canRemember({ kind: 'purchase', target: 'amazon.com' })).toBe(false)
    expect(canRemember({ kind: 'booking', target: 'opentable.com' })).toBe(false)
    expect(canRemember({ kind: 'other', target: 'x' })).toBe(false)
  })

  it('only counts one exact destination, judged by the shape each kind needs', () => {
    const one: [string, string][] = [
      ['email', 'bob@acme.com'], ['message', '#ops'], ['message', '@alice'], ['message', 'bob on slack'],
      ['post', '@acme'], ['post', 'x.com/acme'], ['post', 'https://www.linkedin.com/company/acme'], ['post', 'r/selfhosted'],
    ]
    const vague: [string, string, RegExp][] = [
      ['email', '*', /wildcard/], ['email', '*@acme.com', /wildcard/], ['email', 'a@x.com, b@y.com', /more than one/],
      ['email', 'bob and alice', /more than one/], ['email', 'everyone', /means everyone/], ['email', 'acme.com', /not a single email/],
      ['message', '@channel', /means everyone/], ['message', 'slack', /whole service/], ['message', 'slack.com', /whole site/],
      ['post', 'twitter', /whole service/], ['post', 'x.com', /whole site/], ['post', 'acme blog', /does not name one/],
    ]
    for (const [kind, target] of one) {
      expect(destinationProblem(kind as never, normalizeTarget(target)), `${kind} ${target}`).toBeNull()
      expect(canRemember({ kind: kind as never, target: normalizeTarget(target) })).toBe(true)
    }
    for (const [kind, target, why] of vague) {
      expect(destinationProblem(kind as never, normalizeTarget(target)), `${kind} ${target}`).toMatch(why)
      expect(canRemember({ kind: kind as never, target: normalizeTarget(target) })).toBe(false)
    }
    expect(rememberBlock({ kind: 'purchase', target: 'amazon.com' })).toMatch(/always ask/)
    expect(rememberBlock({ kind: 'email', target: 'bob@acme.com' })).toBeNull()
  })

  it('records an approval a rule already covered as approved, with the rule it came from', () => {
    const { db, threadId } = setup()
    const a = createApproval(db, {
      threadId, botId: bot.id, action: 'send', kind: 'email', target: 'bob@acme.com', ruleId: 4, now: 1000,
    })
    expect(a).toMatchObject({ status: 'approved', rule_id: 4, resolved_at: 1000, kind: 'email', target: 'bob@acme.com' })
    expect(latestPendingApproval(db, threadId)).toBeNull()
  })
})

describe('approval rules', () => {
  const HOUR = 60 * 60_000

  it('matches the same bot, kind and destination, ignoring case', () => {
    const { db } = setup()
    const rule = createRule(db, { botId: bot.id, kind: 'email', target: 'Bob@Acme.com', duration: 'always', now: 0 })
    expect(rule).toMatchObject({ target: 'bob@acme.com', expires_at: null })
    expect(findMatchingRule(db, { botId: bot.id, kind: 'email', target: 'BOB@acme.com', now: 5 })!.id).toBe(rule.id)
  })

  it('does not stretch to another destination, another kind or another teammate', () => {
    const { db } = setup()
    createRule(db, { botId: bot.id, kind: 'email', target: 'bob@acme.com', duration: 'always', now: 0 })
    expect(findMatchingRule(db, { botId: bot.id, kind: 'email', target: 'eve@acme.com', now: 1 })).toBeNull()
    expect(findMatchingRule(db, { botId: bot.id, kind: 'message', target: 'bob@acme.com', now: 1 })).toBeNull()
    expect(findMatchingRule(db, { botId: 'researcher', kind: 'email', target: 'bob@acme.com', now: 1 })).toBeNull()
    expect(findMatchingRule(db, { botId: bot.id, kind: 'email', target: '', now: 1 })).toBeNull()
  })

  it('stops matching when it expires', () => {
    const { db } = setup()
    createRule(db, { botId: bot.id, kind: 'post', target: '#ops', duration: '1h', now: 0 })
    expect(findMatchingRule(db, { botId: bot.id, kind: 'post', target: '#ops', now: HOUR - 1 })).not.toBeNull()
    expect(findMatchingRule(db, { botId: bot.id, kind: 'post', target: '#ops', now: HOUR })).toBeNull()
    expect(listActiveRules(db, bot.id, HOUR)).toEqual([])
  })

  it('stops matching once revoked, and revoking twice is a no-op', () => {
    const { db } = setup()
    const rule = createRule(db, { botId: bot.id, kind: 'message', target: '#ops', duration: '24h', now: 0 })
    expect(revokeRule(db, rule.id, 10)).toMatchObject({ revoked_at: 10 })
    expect(revokeRule(db, rule.id, 11)).toBeNull()
    expect(findMatchingRule(db, { botId: bot.id, kind: 'message', target: '#ops', now: 12 })).toBeNull()
  })

  it('refuses to write a rule for money or for an action with no destination', () => {
    const { db } = setup()
    expect(() => createRule(db, { botId: bot.id, kind: 'purchase', target: 'amazon.com', duration: 'always', now: 0 }))
      .toThrow(/cannot remember this: purchases, bookings/)
    expect(() => createRule(db, { botId: bot.id, kind: 'email', target: '  ', duration: 'always', now: 0 }))
      .toThrow(/cannot remember this: there is no destination/)
  })

  it('refuses a rule whose destination is not one place', () => {
    const { db } = setup()
    for (const target of ['*', 'everyone', 'a@x.com, b@y.com', 'all customers']) {
      expect(() => createRule(db, { botId: bot.id, kind: 'email', target, duration: '1h', now: 0 })).toThrow(/cannot remember this/)
    }
    expect(listActiveRules(db, bot.id, 1)).toEqual([])
  })

  it('no longer honours a vague rule written before destinations were checked', () => {
    const { db } = setup()
    db.prepare(`INSERT INTO approval_rules (bot_id, kind, target, expires_at, created_at) VALUES (?, 'email', '*', NULL, 0)`).run(bot.id)
    expect(findMatchingRule(db, { botId: bot.id, kind: 'email', target: '*', now: 1 })).toBeNull()
    expect(listActiveRules(db, bot.id, 1)).toHaveLength(1) // 还列着，面板上标成「不再生效」
  })
})
