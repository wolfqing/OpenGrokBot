import type { RoutinePayload } from '../types'

export function RoutineChip({ payload }: { payload: RoutinePayload }) {
  const watch = payload.mode === 'watch'
  return (
    <div className="routine-chip">
      <div className="routine-label">{watch ? 'Created watch' : 'Created routine'}</div>
      <div className="routine-name">{watch ? '👁' : payload.webhook && !payload.cron ? '🔗' : '🕐'} {payload.name}</div>
      <div className="routine-when">{payload.human}</div>
      {watch ? (
        <div className="routine-hint">Each run only looks: read-only tools, and it speaks up only when something needs you.</div>
      ) : null}
      {payload.webhook ? (
        <div className="routine-hint">Copy its webhook address from the computer panel and paste it where the event comes from.</div>
      ) : null}
    </div>
  )
}
