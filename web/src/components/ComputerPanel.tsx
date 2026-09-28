import type { ComputerInfo, RoutineAction } from '../types'

const formatCount = (n: number) => n.toLocaleString('en-US')

export function ComputerPanel({ info, botName, onClose, onRoutine }: {
  info: ComputerInfo
  botName: string
  onClose: () => void
  onRoutine?: (id: number, action: RoutineAction) => void
}) {
  return (
    <aside className="computer-panel">
      <header className="panel-header">
        <span className="panel-title">{botName}&apos;s computer</span>
        <button className="panel-close" onClick={onClose} aria-label="Close">✕</button>
      </header>

      {info.vncUrl ? (
        <iframe className="panel-screen" title={`${botName}'s screen`} src={info.vncUrl} />
      ) : (
        <div className="panel-offline">
          <div className="panel-offline-title">No screen right now</div>
          <div className="panel-offline-why">{info.error ?? 'This teammate has no computer attached.'}</div>
        </div>
      )}

      <div className="panel-section">
        <div className="panel-section-title">Routines</div>
        {info.routines.length === 0 ? (
          <div className="panel-empty">No routines yet.</div>
        ) : (
          info.routines.map((r) => {
            const paused = r.enabled === 0
            return (
              <div className={`panel-routine${paused ? ' paused' : ''}`} key={r.id}>
                <div className="panel-routine-text">
                  <span className="panel-routine-name">{r.name}</span>
                  <span className="panel-routine-when">
                    {r.human}
                    {paused ? <span className="panel-routine-paused">paused</span> : null}
                  </span>
                </div>
                {onRoutine ? (
                  <div className="panel-routine-actions">
                    <button onClick={() => onRoutine(r.id, 'run')} aria-label={`Run ${r.name} now`} title="Run now">▶</button>
                    <button
                      onClick={() => onRoutine(r.id, paused ? 'resume' : 'pause')}
                      aria-label={`${paused ? 'Resume' : 'Pause'} ${r.name}`}
                      title={paused ? 'Resume' : 'Pause'}
                    >
                      {paused ? '↻' : '❚❚'}
                    </button>
                    <button onClick={() => onRoutine(r.id, 'delete')} aria-label={`Delete ${r.name}`} title="Delete">✕</button>
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      {info.usage ? (
        <div className="panel-section">
          <div className="panel-section-title">Model use today</div>
          <div className="panel-usage">
            {formatCount(info.usage.today.total)} tokens
            {info.usage.budget ? ` of ${formatCount(info.usage.budget)} budget` : ''}
          </div>
        </div>
      ) : null}

      <div className="panel-foot">
        Signing in here happens in this teammate&apos;s own browser. The session stays on its computer — you
        never hand it a password in chat.
      </div>
    </aside>
  )
}
