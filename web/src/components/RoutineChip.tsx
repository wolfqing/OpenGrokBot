import type { RoutinePayload } from '../types'

export function RoutineChip({ payload }: { payload: RoutinePayload }) {
  return (
    <div className="routine-chip">
      <div className="routine-label">Created routine</div>
      <div className="routine-name">🕐 {payload.name}</div>
      <div className="routine-when">{payload.human}</div>
    </div>
  )
}
