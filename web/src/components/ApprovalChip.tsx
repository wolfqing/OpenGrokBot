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

/** 一批里先摊开这么多项，再多的折起来 */
const SHOWN_ITEMS = 6

/** 一批对象：待批时每项一个勾，默认全勾；批完后放行的打 ✓，留下的划掉 */
function BatchItems({ items, kept, onToggle, approved }: {
  items: string[]
  kept: Set<number>
  onToggle?: (index: number) => void
  approved?: number[]
}) {
  const [all, setAll] = useState(items.length <= SHOWN_ITEMS)
  const shown = all ? items : items.slice(0, SHOWN_ITEMS)
  const done = approved ? new Set(approved) : null
  return (
    <div className="approval-items">
      <ul>
        {shown.map((item, i) => (
          <li key={i} className={done && !done.has(i) ? 'left-out' : undefined}>
            {onToggle ? (
              <label>
                <input type="checkbox" checked={kept.has(i)} onChange={() => onToggle(i)} />
                <span>{item}</span>
              </label>
            ) : (
              <span>{done?.has(i) ? '✓ ' : ''}{item}</span>
            )}
          </li>
        ))}
      </ul>
      {all ? null : (
        <button className="approval-items-more" onClick={() => setAll(true)}>Show all {items.length}</button>
      )}
    </div>
  )
}

export function ApprovalChip({ payload, onDecide }: {
  payload: ApprovalPayload
  onDecide: (approvalId: number, decision: 'approve' | 'discard', remember?: RuleDuration, items?: number[]) => void
}) {
  const [choosing, setChoosing] = useState(false)
  const items = payload.items ?? []
  const [kept, setKept] = useState(() => new Set(items.map((_, i) => i)))
  const toggle = (i: number) => setKept((k) => {
    const next = new Set(k)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    return next
  })
  const scope = payload.kind && payload.target ? `${payload.kind} → ${payload.target}` : null
  // 全勾着就不传下标：网关默认整批放行
  const approve = () => {
    if (items.length && kept.size < items.length) {
      onDecide(payload.approvalId, 'approve', undefined, [...kept].sort((a, b) => a - b))
    } else {
      onDecide(payload.approvalId, 'approve')
    }
  }

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
  const approvedCount = payload.approvedItems?.length
  return (
    <div className={`approval-chip${outcome ? ' resolved' : ''}`}>
      <div className="approval-label">{items.length ? `Needs you · ${items.length} items` : 'Needs you'}</div>
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
      {items.length ? (
        <BatchItems
          items={items}
          kept={kept}
          {...(outcome ? { approved: payload.approvedItems ?? [] } : { onToggle: toggle })}
        />
      ) : null}
      {outcome ? (
        <div className="approval-outcome">
          {outcome}
          {items.length && approvedCount !== undefined ? ` ${approvedCount} of ${items.length}` : ''}
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
          <button className="approve" disabled={items.length > 0 && kept.size === 0} onClick={approve}>
            {!items.length ? 'Approve' : kept.size === items.length ? `Approve all ${items.length}` : `Approve ${kept.size} of ${items.length}`}
          </button>
          <button className="discard" onClick={() => onDecide(payload.approvalId, 'discard')}>Discard</button>
          {payload.canRemember ? (
            <button className="remember-toggle" onClick={() => setChoosing(true)}>Always allow…</button>
          ) : null}
        </div>
      )}
    </div>
  )
}
