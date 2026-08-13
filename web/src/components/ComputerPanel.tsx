import type { ComputerInfo } from '../types'

export function ComputerPanel({ info, botName, onClose }: {
  info: ComputerInfo
  botName: string
  onClose: () => void
}) {
  return (
    <aside className="computer-panel">
      <header className="panel-header">
        <span className="panel-title">{botName}&apos;s computer</span>
        <button className="panel-close" onClick={onClose} aria-label="Close">✕</button>
      </header>

      {info.vncUrl ? (
        <iframe
          className="panel-screen"
          title={`${botName}'s screen`}
          src={`${info.vncUrl}/vnc.html?autoconnect=1&resize=scale&reconnect=1`}
        />
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
          info.routines.map((r) => (
            <div className="panel-routine" key={r.id}>
              <span className="panel-routine-name">{r.name}</span>
              <span className="panel-routine-when">{r.human}</span>
            </div>
          ))
        )}
      </div>

      <div className="panel-foot">
        Signing in here happens in this teammate&apos;s own browser. The session stays on its computer — you
        never hand it a password in chat.
      </div>
    </aside>
  )
}
