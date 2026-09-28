import { useState } from 'react'
import type { ActivityPayload } from '../types'

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 一个回合在电脑上做了什么：干活时显示当前这一步，干完收成一行，点开看每一步。 */
export function ActivityChip({ payload }: { payload: ActivityPayload }) {
  const [open, setOpen] = useState(false)
  const steps = payload.steps
  const failed = steps.filter((s) => s.ok === false).length
  const totalMs = steps.reduce((sum, s) => sum + (s.ms ?? 0), 0)
  const current = payload.done ? null : steps[steps.length - 1]
  return (
    <div className={`activity-chip${payload.done ? '' : ' running'}`}>
      <button className="activity-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="activity-label">{payload.done ? 'Worked' : 'Working'}</span>
        <span className="activity-meta">
          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
          {failed ? ` · ${failed} failed` : ''}
          {payload.done && totalMs ? ` · ${formatMs(totalMs)}` : ''}
        </span>
        <span className="activity-caret">{open ? '▾' : '▸'}</span>
      </button>
      {current && !open ? (
        <div className="activity-current">
          <span className="activity-tool">{current.tool}</span>
          <span className="activity-summary">{current.summary}</span>
        </div>
      ) : null}
      {open ? (
        <ol className="activity-steps">
          {steps.map((s, i) => (
            <li key={i} className={s.ok === false ? 'failed' : undefined}>
              <span className="activity-mark">{s.ok === undefined ? '…' : s.ok ? '✓' : '✕'}</span>
              <span className="activity-tool">{s.tool}</span>
              <span className="activity-summary">{s.summary}</span>
              {s.ms !== undefined ? <span className="activity-ms">{formatMs(s.ms)}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
