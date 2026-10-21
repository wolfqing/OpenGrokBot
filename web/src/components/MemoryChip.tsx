import type { MemoryPayload } from '../types'

export function MemoryChip({ payload }: { payload: MemoryPayload }) {
  return (
    <div className="memory-chip">
      <div className="memory-label">{payload.removed ? 'Memory: rule removed' : 'Memory updated'}</div>
      <div className={`memory-rule${payload.removed ? ' removed' : ''}`}>{payload.rule}</div>
      <pre className={`memory-diff${payload.removed ? ' removed' : ''}`}>{payload.diff}</pre>
      <div className="memory-total">
        {payload.by === 'operator' ? 'Removed by you from the computer panel · ' : ''}
        {payload.total === 1 ? '1 rule on file' : `${payload.total} rules on file`}
      </div>
    </div>
  )
}
