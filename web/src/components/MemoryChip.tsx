import type { MemoryPayload } from '../types'

export function MemoryChip({ payload }: { payload: MemoryPayload }) {
  return (
    <div className="memory-chip">
      <div className="memory-label">Memory updated</div>
      <div className="memory-rule">{payload.rule}</div>
      <pre className="memory-diff">{payload.diff}</pre>
      <div className="memory-total">{payload.total === 1 ? '1 rule on file' : `${payload.total} rules on file`}</div>
    </div>
  )
}
