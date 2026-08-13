import type { LoginPayload } from '../types'

export function LoginChip({ payload, onOpenScreen }: {
  payload: LoginPayload
  onOpenScreen: () => void
}) {
  return (
    <div className="login-chip">
      <div className="login-label">Needs you at the keyboard</div>
      <div className="login-site">Sign in to {payload.site}</div>
      {payload.why ? <div className="login-why">{payload.why}</div> : null}
      <button className="login-open" onClick={onOpenScreen}>Open its screen</button>
    </div>
  )
}
