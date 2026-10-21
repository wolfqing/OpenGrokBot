import type { RoutinePayload } from '../types'

export function RoutineChip({ payload }: { payload: RoutinePayload }) {
  return (
    <div className="routine-chip">
      <div className="routine-label">Created routine</div>
      <div className="routine-name">{payload.webhook && !payload.cron ? '🔗' : '🕐'} {payload.name}</div>
      <div className="routine-when">{payload.human}</div>
      {payload.webhook ? (
        <div className="routine-hint">Copy its webhook address from the computer panel and paste it where the event comes from.</div>
      ) : null}
    </div>
  )
}
