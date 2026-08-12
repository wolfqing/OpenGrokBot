import type { ReportPayload } from '../types'

export function ReportChip({ payload }: { payload: ReportPayload }) {
  return (
    <div className="report-chip">
      {payload.lines.map((line, i) => (
        <div className="report-line" key={i}>
          <span className="report-check">✓</span>
          <span className="report-system">{line.system}</span>
          <span className="report-arrow">→</span>
          <span className="report-result">
            {line.result}
            {line.count ? <span className="report-count"> · {line.count}</span> : null}
          </span>
        </div>
      ))}
      {payload.closing ? <div className="report-closing">{payload.closing}</div> : null}
    </div>
  )
}
