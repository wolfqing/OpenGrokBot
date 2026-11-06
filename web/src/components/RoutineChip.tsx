import type { RoutinePayload } from '../types'
import { useT } from '../i18n'

export function RoutineChip({ payload }: { payload: RoutinePayload }) {
  const t = useT()
  const watch = payload.mode === 'watch'
  return (
    <div className="routine-chip">
      <div className="routine-label">{t(watch ? 'routine.createdWatch' : 'routine.createdRoutine')}</div>
      <div className="routine-name">{watch ? '👁' : payload.webhook && !payload.cron ? '🔗' : '🕐'} {payload.name}</div>
      <div className="routine-when">{payload.human}</div>
      {watch ? (
        <div className="routine-hint">{t('routine.watchHint')}</div>
      ) : null}
      {payload.webhook ? (
        <div className="routine-hint">{t('routine.webhookHint')}</div>
      ) : null}
    </div>
  )
}
