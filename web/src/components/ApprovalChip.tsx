import type { ApprovalPayload } from '../types'

const OUTCOME: Record<string, string> = { approved: 'Approved', discarded: 'Discarded' }

export function ApprovalChip({ payload, onDecide }: {
  payload: ApprovalPayload
  onDecide: (approvalId: number, decision: 'approve' | 'discard') => void
}) {
  const outcome = OUTCOME[payload.status]
  return (
    <div className={`approval-chip${outcome ? ' resolved' : ''}`}>
      <div className="approval-label">Needs you</div>
      <div className="approval-action">{payload.action}</div>
      {payload.detail ? <div className="approval-detail">{payload.detail}</div> : null}
      {outcome ? (
        <div className="approval-outcome">{outcome}</div>
      ) : (
        <div className="approval-buttons">
          <button className="approve" onClick={() => onDecide(payload.approvalId, 'approve')}>Approve</button>
          <button className="discard" onClick={() => onDecide(payload.approvalId, 'discard')}>Discard</button>
        </div>
      )}
    </div>
  )
}
