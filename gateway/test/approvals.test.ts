import { describe, expect, it } from 'vitest'
import {
  attachApprovalMessage, createApproval, getApproval, isThumbsUp, latestPendingApproval, resolveApproval,
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
