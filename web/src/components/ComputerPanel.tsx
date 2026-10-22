import { useEffect, useState } from 'react'
import type { ActionEntry, ComputerInfo, ComputerRoutine, RoutineAction } from '../types'
import { untilLabel } from './ApprovalChip'

const formatCount = (n: number) => n.toLocaleString('en-US')

/** 睡着的电脑要十几秒才醒：面板先打开，告诉人在等什么、等了多久，而不是按钮按下去毫无反应。 */
function Waking({ botName }: { botName: string }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="panel-loading" role="status">
      <span className="panel-spinner" aria-hidden="true" />
      <div className="panel-loading-title">Starting {botName}&apos;s computer…</div>
      <div className="panel-loading-why">
        One that was asleep takes 10–20 seconds to wake. Its logins and files come back with it.
      </div>
      {seconds >= 3 ? <div className="panel-loading-elapsed">{seconds}s</div> : null}
    </div>
  )
}

type PanelActions = {
  onRoutine?: (id: number, action: RoutineAction) => void
  /** 撤销一条「以后都放行」 */
  onRevokeRule?: (id: number) => void
  /** 从 MEMORY.md 删掉一条规矩（原句） */
  onForgetRule?: (rule: string) => void
}

/** webhook 地址带着密钥：给一个「复制」，不把它整串摊在面板上 */
function CopyWebhook({ routine }: { routine: ComputerRoutine }) {
  const [copied, setCopied] = useState(false)
  if (!routine.webhook_path) return null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${routine.webhook_path}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy the webhook address:', `${location.origin}${routine.webhook_path}`)
    }
  }
  return (
    <button className="panel-copy" onClick={() => void copy()} aria-label={`Copy the webhook address of ${routine.name}`}>
      {copied ? 'Copied' : 'Copy webhook'}
    </button>
  )
}

/** 谁叫它开始的，用人话 */
const TRIGGER: Record<string, string> = {
  you: 'you', group: 'group', handoff: 'handoff', approval: 'after approval', question: 'your answer',
  routine: 'routine', watch: 'watch', webhook: 'webhook',
}

function actionTime(ts: number, now = new Date()): string {
  const at = new Date(ts)
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

function RecentActions({ actions }: { actions: ActionEntry[] }) {
  return (
    <div className="panel-section">
      <div className="panel-section-title">Recent actions</div>
      {actions.length === 0 ? (
        <div className="panel-empty">Nothing yet. Every step it takes is logged here.</div>
      ) : (
        <ol className="panel-actions">
          {actions.map((a) => (
            <li key={a.id} className={a.ok === false ? 'failed' : undefined}>
              <span className="panel-action-mark">{a.ok === null ? '·' : a.ok ? '✓' : '✕'}</span>
              <span className="panel-action-text">
                <span className="panel-action-tool">{a.tool}</span> {a.summary}
              </span>
              <span className="panel-action-meta">{actionTime(a.created_at)} · {TRIGGER[a.trigger] ?? a.trigger}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function ComputerPanel({ info, botName, onClose, ...actions }: {
  /** null = 还在拉起这台电脑 */
  info: ComputerInfo | null
  botName: string
  onClose: () => void
} & PanelActions) {
  return (
    <aside className="computer-panel">
      <header className="panel-header">
        <span className="panel-title">{botName}&apos;s computer</span>
        <button className="panel-close" onClick={onClose} aria-label="Close">✕</button>
      </header>

      {!info ? <Waking botName={botName} /> : <PanelBody info={info} botName={botName} {...actions} />}

      <div className="panel-foot">
        Signing in here happens in this teammate&apos;s own browser. The session stays on its computer — you
        never hand it a password in chat.
      </div>
    </aside>
  )
}

function PanelBody({ info, botName, onRoutine, onRevokeRule, onForgetRule }: {
  info: ComputerInfo
  botName: string
} & PanelActions) {
  const rules = info.rules ?? []
  const memory = info.memory ?? []
  const skills = info.skills ?? []
  return (
    <>
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
                    {r.mode === 'watch' ? <span className="panel-routine-tag">watch</span> : null}
                    {paused ? <span className="panel-routine-paused">paused</span> : null}
                  </span>
                  <CopyWebhook routine={r} />
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

      <div className="panel-section">
        <div className="panel-section-title">Allowed without asking</div>
        {rules.length === 0 ? (
          <div className="panel-empty">Nothing goes out without your approval.</div>
        ) : (
          rules.map((rule) => (
            <div className={`panel-rule${rule.applies === false ? ' inert' : ''}`} key={rule.id}>
              <div className="panel-routine-text">
                <span className="panel-rule-scope">{rule.kind} → {rule.target}</span>
                <span className="panel-routine-when">
                  {rule.applies === false ? `No longer applies: ${rule.whyNot ?? 'not one destination'}` : untilLabel(rule.expiresAt)}
                </span>
              </div>
              {onRevokeRule ? (
                <div className="panel-routine-actions">
                  <button
                    onClick={() => onRevokeRule(rule.id)}
                    aria-label={`Stop allowing ${rule.kind} to ${rule.target}`}
                    title="Revoke: ask me again next time"
                  >
                    ✕
                  </button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="panel-section">
        <div className="panel-section-title">Standing rules</div>
        {memory.length === 0 ? (
          <div className="panel-empty">No standing rules yet. Tell it &quot;from now on…&quot; in the thread.</div>
        ) : (
          memory.map((rule) => (
            <div className="panel-rule" key={rule}>
              <span className="panel-memory-rule">{rule}</span>
              {onForgetRule ? (
                <div className="panel-routine-actions">
                  <button onClick={() => onForgetRule(rule)} aria-label={`Forget: ${rule}`} title="Forget this rule">✕</button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      {skills.length ? (
        <div className="panel-section">
          <div className="panel-section-title">Shared skills</div>
          {skills.map((s) => (
            <div className="panel-rule" key={s.name}>
              <div className="panel-routine-text">
                <span className="panel-rule-scope">{s.name}</span>
                {s.description ? <span className="panel-skill-why">{s.description}</span> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {info.actions ? <RecentActions actions={info.actions} /> : null}

      {info.usage ? (
        <div className="panel-section">
          <div className="panel-section-title">Model use today</div>
          <div className="panel-usage">
            {formatCount(info.usage.today.total)} tokens
            {info.usage.budget ? ` of ${formatCount(info.usage.budget)} budget` : ''}
          </div>
        </div>
      ) : null}
    </>
  )
}
