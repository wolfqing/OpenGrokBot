import { useState } from 'react'
import type { WebhookPayload } from '../types'

/** 长载荷先收起：一屏能看清来的是什么，要细看再展开 */
const FOLD_CHARS = 600

/** 一次 webhook 调用带来的东西：标明是外部数据，原样给人看，事后查得到是什么让同事动起来的 */
export function WebhookChip({ payload }: { payload: WebhookPayload }) {
  const [open, setOpen] = useState(false)
  const long = payload.body.length > FOLD_CHARS
  const shown = long && !open ? `${payload.body.slice(0, FOLD_CHARS)}…` : payload.body
  return (
    <div className="webhook-chip">
      <div className="webhook-label">Webhook · outside data</div>
      <div className="webhook-name">{payload.name}</div>
      <pre className="webhook-body">{shown}</pre>
      {long ? (
        <button className="webhook-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `Show all ${payload.body.length.toLocaleString('en-US')} characters`}
        </button>
      ) : null}
    </div>
  )
}
