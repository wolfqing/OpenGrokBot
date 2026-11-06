import type { LoginPayload } from '../types'
import { useT } from '../i18n'

export function LoginChip({ payload, onOpenScreen }: {
  payload: LoginPayload
  onOpenScreen: () => void
}) {
  const t = useT()
  return (
    <div className="login-chip">
      <div className="login-label">{t('login.label')}</div>
      <div className="login-site">{t('login.site', { site: payload.site })}</div>
      {payload.why ? <div className="login-why">{payload.why}</div> : null}
      <button className="login-open" onClick={onOpenScreen}>{t('login.open')}</button>
    </div>
  )
}
