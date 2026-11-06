import { useEffect, useState } from 'react'
import { useT, type MessageKey, type T } from '../i18n'
import type { ActionEntry, ComputerInfo, ComputerRoutine, RoutineAction } from '../types'
import { untilLabel } from './ApprovalChip'
import { CdpScreen } from './CdpScreen'

const formatCount = (n: number, t: T) => n.toLocaleString(t.locale ?? 'en-US')

/** 睡着的电脑要十几秒才醒：面板先打开，告诉人在等什么、等了多久，而不是按钮按下去毫无反应。 */
function Waking({ botName }: { botName: string }) {
  const t = useT()
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="panel-loading" role="status">
      <span className="panel-spinner" aria-hidden="true" />
      <div className="panel-loading-title">{t('panel.waking', { name: botName })}</div>
      <div className="panel-loading-why">{t('panel.wakingWhy')}</div>
      {seconds >= 3 ? <div className="panel-loading-elapsed">{t('panel.seconds', { count: seconds })}</div> : null}
    </div>
  )
}

type PanelActions = {
  onRoutine?: (id: number, action: RoutineAction) => void
  /** 撤销一条「以后都放行」 */
  onRevokeRule?: (id: number) => void
  /** 从 MEMORY.md 删掉一条规矩（原句） */
  onForgetRule?: (rule: string) => void
  /** 本机模式：登录完了，把开在桌面上的浏览器窗口收回后台。失败就 reject，面板把原因摆出来 */
  onWindowDone?: () => void | Promise<void>
  /** 本机模式：开关命令行（开之前网关要实测沙箱，得几秒）。失败就 reject */
  onShell?: (enabled: boolean) => void | Promise<void>
}

/** webhook 地址带着密钥：给一个「复制」，不把它整串摊在面板上 */
/** 复制到剪贴板；不让写剪贴板（非 https、权限）就弹框让人手动复制 */
function CopyButton({ label, value, what, aria }: { label: string; value: string; what: string; aria: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt(t('panel.copyPrompt', { what }), value)
    }
  }
  return (
    <button className="panel-copy" onClick={() => void copy()} aria-label={aria}>
      {copied ? t('panel.copied') : label}
    </button>
  )
}

/**
 * 两种接法：普通调用方拿带密钥的整串地址；GitHub 这类发送方填不带密钥的地址，
 * 再把密钥填进它的 Secret，由它给每次请求签名。
 */
function CopyWebhook({ routine }: { routine: ComputerRoutine }) {
  const t = useT()
  if (!routine.webhook_path) return null
  const withKey = `${location.origin}${routine.webhook_path}`
  return (
    <span className="panel-copy-row">
      <CopyButton
        label={t('panel.copyWebhook')} value={withKey} what={t('panel.webhookAddress')}
        aria={t('panel.copyWebhookAria', { name: routine.name })}
      />
      {routine.webhook_secret ? (
        <CopyButton
          label={t('panel.forGithub')}
          value={`Payload URL: ${withKey.replace(/\?key=.*$/, '')}\nContent type: application/json\nSecret: ${routine.webhook_secret}`}
          what={t('panel.githubSettings')}
          aria={t('panel.copyGithubAria', { name: routine.name })}
        />
      ) : null}
    </span>
  )
}

/** 谁叫它开始的，用人话 */
const TRIGGER: Record<string, MessageKey> = {
  you: 'panel.trigger.you', group: 'panel.trigger.group', handoff: 'panel.trigger.handoff',
  approval: 'panel.trigger.approval', question: 'panel.trigger.question', routine: 'panel.trigger.routine',
  watch: 'panel.trigger.watch', webhook: 'panel.trigger.webhook',
}

function actionTime(ts: number, t: T, now = new Date()): string {
  const at = new Date(ts)
  const time = at.toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' })
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString(t.locale, { month: 'short', day: 'numeric' })} ${time}`
}

function RecentActions({ actions }: { actions: ActionEntry[] }) {
  const t = useT()
  const trigger = (name: string) => { const key = TRIGGER[name]; return key ? t(key) : name }
  return (
    <div className="panel-section">
      <div className="panel-section-title">{t('panel.recent')}</div>
      {actions.length === 0 ? (
        <div className="panel-empty">{t('panel.recentEmpty')}</div>
      ) : (
        <ol className="panel-actions">
          {actions.map((a) => (
            <li key={a.id} className={a.ok === false ? 'failed' : undefined}>
              <span className="panel-action-mark">{a.ok === null ? '·' : a.ok ? '✓' : '✕'}</span>
              <span className="panel-action-text">
                <span className="panel-action-tool">{a.tool}</span> {a.summary}
              </span>
              <span className="panel-action-meta">{actionTime(a.created_at, t)} · {trigger(a.trigger)}</span>
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
  const t = useT()
  return (
    <aside className="computer-panel">
      <header className="panel-header">
        <span className="panel-title">{t('panel.title', { name: botName })}</span>
        <button className="panel-close" onClick={onClose} aria-label={t('panel.close')}>✕</button>
      </header>

      {!info ? <Waking botName={botName} /> : <PanelBody info={info} botName={botName} {...actions} />}

      <div className="panel-foot">{t('panel.foot')}</div>
    </aside>
  )
}

function PanelBody({ info, botName, onRoutine, onRevokeRule, onForgetRule, onWindowDone, onShell }: {
  info: ComputerInfo
  botName: string
} & PanelActions) {
  const t = useT()
  const rules = info.rules ?? []
  const memory = info.memory ?? []
  const skills = info.skills ?? []
  // 开关命令行、收回窗口都要等网关几秒：期间锁住控件，失败把原因写在旁边，不用 alert
  const [busy, setBusy] = useState<'shell' | 'window' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const act = async (what: 'shell' | 'window', run: () => void | Promise<void>) => {
    setBusy(what)
    setProblem(null)
    try {
      await run()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      {info.screen?.kind === 'cdp' ? (
        <CdpScreen url={info.screen.url} title={t('panel.screen', { name: botName })} />
      ) : info.vncUrl ? (
        <iframe className="panel-screen" title={t('panel.screen', { name: botName })} src={info.vncUrl} />
      ) : (
        <div className="panel-offline">
          <div className="panel-offline-title">{t('panel.noScreen')}</div>
          <div className="panel-offline-why">{info.error ?? t('panel.noComputer')}</div>
        </div>
      )}
      {info.window ? (
        <div className="panel-window" role="status">
          <span>{t('panel.window')}</span>
          {onWindowDone ? (
            <button className="panel-copy" disabled={busy !== null} onClick={() => void act('window', onWindowDone)}>
              {busy === 'window' ? t('panel.windowClosing') : t('panel.windowDone')}
            </button>
          ) : null}
        </div>
      ) : null}
      {info.kind ? (
        <div className="panel-kind">
          {t(info.kind === 'local' ? 'panel.kindLocal' : 'panel.kindDocker')}
        </div>
      ) : null}
      {info.kind === 'local' && info.shell ? (
        <div className="panel-section">
          <div className="panel-section-title">{t('panel.commands')}</div>
          <label className="panel-switch">
            <input
              type="checkbox"
              checked={info.shell.enabled}
              disabled={!info.shell.available || !onShell || busy !== null}
              onChange={(e) => { const next = e.target.checked; void act('shell', () => onShell?.(next)) }}
              aria-label={t('panel.allowCommands')}
            />
            <span>
              {t('panel.shellText')}
              {info.shell.available
                ? t('panel.shellSafe')
                : t('panel.shellUnavailable', { why: info.shell.why ?? t('panel.noSandbox') })}
              {busy === 'shell' ? t('panel.checkingSandbox') : ''}
            </span>
          </label>
        </div>
      ) : null}
      {problem ? <div className="panel-problem" role="alert">{problem}</div> : null}

      <div className="panel-section">
        <div className="panel-section-title">{t('panel.routines')}</div>
        {info.routines.length === 0 ? (
          <div className="panel-empty">{t('panel.noRoutines')}</div>
        ) : (
          info.routines.map((r) => {
            const paused = r.enabled === 0
            return (
              <div className={`panel-routine${paused ? ' paused' : ''}`} key={r.id}>
                <div className="panel-routine-text">
                  <span className="panel-routine-name">{r.name}</span>
                  <span className="panel-routine-when">
                    {r.human}
                    {r.mode === 'watch' ? <span className="panel-routine-tag">{t('panel.watchTag')}</span> : null}
                    {paused ? <span className="panel-routine-paused">{t('panel.paused')}</span> : null}
                  </span>
                  <CopyWebhook routine={r} />
                </div>
                {onRoutine ? (
                  <div className="panel-routine-actions">
                    <button onClick={() => onRoutine(r.id, 'run')} aria-label={t('panel.runNowAria', { name: r.name })} title={t('panel.runNow')}>▶</button>
                    <button
                      onClick={() => onRoutine(r.id, paused ? 'resume' : 'pause')}
                      aria-label={t(paused ? 'panel.resumeAria' : 'panel.pauseAria', { name: r.name })}
                      title={t(paused ? 'panel.resume' : 'panel.pause')}
                    >
                      {paused ? '↻' : '❚❚'}
                    </button>
                    <button onClick={() => onRoutine(r.id, 'delete')} aria-label={t('panel.deleteAria', { name: r.name })} title={t('panel.delete')}>✕</button>
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <div className="panel-section">
        <div className="panel-section-title">{t('panel.allowed')}</div>
        {rules.length === 0 ? (
          <div className="panel-empty">{t('panel.allowedEmpty')}</div>
        ) : (
          rules.map((rule) => (
            <div className={`panel-rule${rule.applies === false ? ' inert' : ''}`} key={rule.id}>
              <div className="panel-routine-text">
                <span className="panel-rule-scope">{rule.kind} → {rule.target}</span>
                <span className="panel-routine-when">
                  {rule.applies === false
                    ? t('panel.noLongerApplies', { why: rule.whyNot ?? t('panel.notOneDestination') })
                    : untilLabel(rule.expiresAt, t)}
                </span>
              </div>
              {onRevokeRule ? (
                <div className="panel-routine-actions">
                  <button
                    onClick={() => onRevokeRule(rule.id)}
                    aria-label={t('panel.revokeAria', { kind: rule.kind, target: rule.target })}
                    title={t('panel.revokeTitle')}
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
        <div className="panel-section-title">{t('panel.standing')}</div>
        {memory.length === 0 ? (
          <div className="panel-empty">{t('panel.standingEmpty')}</div>
        ) : (
          memory.map((rule) => (
            <div className="panel-rule" key={rule}>
              <span className="panel-memory-rule">{rule}</span>
              {onForgetRule ? (
                <div className="panel-routine-actions">
                  <button onClick={() => onForgetRule(rule)} aria-label={t('panel.forgetAria', { rule })} title={t('panel.forgetTitle')}>✕</button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      {skills.length ? (
        <div className="panel-section">
          <div className="panel-section-title">{t('panel.skills')}</div>
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
          <div className="panel-section-title">{t('panel.usage')}</div>
          <div className="panel-usage">
            {t('panel.tokens', { count: formatCount(info.usage.today.total, t) })}
            {info.usage.budget ? t('panel.ofBudget', { budget: formatCount(info.usage.budget, t) }) : ''}
          </div>
        </div>
      ) : null}
    </>
  )
}
