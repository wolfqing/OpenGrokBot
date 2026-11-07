import type { MemoryPayload } from '../types'
import { useT } from '../i18n'

export function MemoryChip({ payload }: { payload: MemoryPayload }) {
  const t = useT()
  return (
    <div className="memory-chip">
      <div className="memory-label">{t(payload.removed ? 'memory.removed' : 'memory.updated')}</div>
      <div className={`memory-rule${payload.removed ? ' removed' : ''}`}>{payload.rule}</div>
      <pre className={`memory-diff${payload.removed ? ' removed' : ''}`}>{payload.diff}</pre>
      <div className="memory-total">
        {payload.by === 'operator' ? t('memory.byOperator') : ''}
        {payload.total === 1 ? t('memory.totalOne') : t('memory.totalMany', { count: payload.total })}
      </div>
    </div>
  )
}
