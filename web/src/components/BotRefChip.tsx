import type { BotRefPayload } from '../types'
import { useT } from '../i18n'

export function BotRefChip({ payload }: { payload: BotRefPayload }) {
  const t = useT()
  return (
    <div className="botref-chip">
      <div className="botref-label">{t('botref.label', { name: payload.fromName })}</div>
      <div className="botref-body">{payload.content}</div>
    </div>
  )
}
