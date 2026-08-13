import type { ScreenshotPayload } from '../types'

export function ScreenshotChip({ payload }: { payload: ScreenshotPayload }) {
  return (
    <figure className="shot-chip">
      <img
        className="shot-img"
        src={payload.url}
        width={payload.width}
        height={payload.height}
        alt={payload.caption ?? "Bot's screen"}
        loading="lazy"
      />
      {payload.caption ? <figcaption className="shot-caption">{payload.caption}</figcaption> : null}
    </figure>
  )
}
