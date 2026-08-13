import type { BotRefPayload } from '../types'

export function BotRefChip({ payload }: { payload: BotRefPayload }) {
  return (
    <div className="botref-chip">
      <div className="botref-label">Messages from @{payload.fromName}</div>
      <div className="botref-body">{payload.content}</div>
    </div>
  )
}
