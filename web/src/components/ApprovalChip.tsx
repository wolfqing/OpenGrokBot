import { useState } from 'react'
import type { ApprovalPayload, RuleDuration } from '../types'

const OUTCOME: Record<string, string> = { approved: 'Approved', discarded: 'Discarded' }

/** 规则为什么这次没放行：只认你自己开头的活 */
const HELD_BECAUSE: Record<string, string> = {
  webhook: 'this came in through a webhook',
  routine: 'a routine started this, not you',
  relay: 'a teammate handed this over',
  'outside-data': 'webhook data is still in view',
  unknown: 'you did not start this',
}

const DURATIONS: { value: RuleDuration; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
  { value: 'always', label: 'Until I revoke it' },
]

/** 规则管到什么时候：今天之内只写钟点，跨天带上日期 */
export function untilLabel(expiresAt: number | null, now = new Date()): string {
  if (expiresAt === null) return 'until you revoke it'
  const at = new Date(expiresAt)
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === now.toDateString()
    ? `until ${time}`
    : `until ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

export function ApprovalChip({ payload, onDecide }: {
  payload: ApprovalPayload
  onDecide: (approvalId: number, decision: 'approve' | 'discard', remember?: RuleDuration) => void
}) {
  const [choosing, setChoosing] = useState(false)
  const scope = payload.kind && payload.target ? `${payload.kind} → ${payload.target}` : null

  // 一条你早先留下的规则已经放行了它：只是告诉你发生了什么，没有按钮
  if (payload.rule) {
    return (
      <div className="approval-chip resolved by-rule">
        <div className="approval-label">Allowed by your rule</div>
        <div className="approval-action">{payload.action}</div>
        {payload.detail ? <div className="approval-detail">{payload.detail}</div> : null}
        <div className="approval-outcome">
          Went ahead without asking: {payload.rule.kind} → {payload.rule.target}, {untilLabel(payload.rule.expiresAt)}.
          Revoke it from the computer panel.
        </div>
      </div>
    )
  }

  const outcome = OUTCOME[payload.status]
  return (
    <div className={`approval-chip${outcome ? ' resolved' : ''}`}>
      <div className="approval-label">Needs you</div>
      <div className="approval-action">{payload.action}</div>
      {payload.detail ? <div className="approval-detail">{payload.detail}</div> : null}
      {scope ? <div className="approval-scope">{scope}</div> : null}
      {payload.ruleHeld && !outcome ? (
        <div className="approval-note">
          Your standing rule covers {scope ?? 'this'}, but rules only apply to work you start yourself:{' '}
          {HELD_BECAUSE[payload.ruleHeld] ?? HELD_BECAUSE.unknown}.
        </div>
      ) : null}
      {payload.rememberBlocked && !outcome ? (
        <div className="approval-note">No &quot;Always allow&quot;: {payload.rememberBlocked}.</div>
      ) : null}
      {outcome ? (
        <div className="approval-outcome">
          {outcome}
          {payload.remembered && scope ? ` · ${scope} allowed ${untilLabel(payload.remembered.expiresAt)}` : ''}
        </div>
      ) : choosing ? (
        <div className="approval-remember">
          <div className="approval-remember-why">Approve this, and stop asking about {scope} for:</div>
          <div className="approval-buttons">
            {DURATIONS.map((d) => (
              <button key={d.value} className="remember" onClick={() => onDecide(payload.approvalId, 'approve', d.value)}>
                {d.label}
              </button>
            ))}
            <button className="discard" onClick={() => setChoosing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="approval-buttons">
          <button className="approve" onClick={() => onDecide(payload.approvalId, 'approve')}>Approve</button>
          <button className="discard" onClick={() => onDecide(payload.approvalId, 'discard')}>Discard</button>
          {payload.canRemember ? (
            <button className="remember-toggle" onClick={() => setChoosing(true)}>Always allow…</button>
          ) : null}
        </div>
      )}
    </div>
  )
}
