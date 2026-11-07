import type { ScreenshotPayload } from '../types'
import { useT } from '../i18n'

export function ScreenshotChip({ payload }: { payload: ScreenshotPayload }) {
  const t = useT()
  return (
    <figure className="shot-chip">
      <img
        className="shot-img"
        src={payload.url}
        width={payload.width}
        height={payload.height}
        alt={payload.caption ?? t('screenshot.alt')}
        loading="lazy"
      />
      {payload.caption ? <figcaption className="shot-caption">{payload.caption}</figcaption> : null}
    </figure>
  )
}
