import type {
  ActivityPayload, ApprovalPayload, ApprovalResolvedPayload, BotRefPayload, BotStatus, Conversation, LoginPayload,
  MemoryPayload, QuestionPayload, ReportPayload, RoutinePayload, ScreenshotPayload, WebhookPayload,
} from '../types'
import { useT, type MessageKey, type T } from '../i18n'
import { isNotice, noticeText } from '../i18n/describe'

/**
 * 单聊就是那位同事的状态。群只说「有人在干活」：等你、卡住、刚干完说的是某一位同事，
 * 该在它自己那一行出现，挂在群上会让人点进群里找一件不在群里的事。
 */
export function conversationState(c: Conversation, statuses: Record<string, BotStatus>): BotStatus {
  if (c.kind === 'dm') return statuses[c.members[0] ?? ''] ?? 'idle'
  return c.members.some((id) => statuses[id] === 'thinking') ? 'thinking' : 'idle'
}

const STATE_TEXT: Partial<Record<BotStatus, MessageKey>> = {
  thinking: 'sidebar.state.thinking', waiting: 'sidebar.state.waiting', blocked: 'sidebar.state.blocked', done: 'sidebar.state.done',
}

function preview(c: Conversation, t: T): string {
  const m = c.last_message
  if (!m) return t(c.kind === 'group' ? 'sidebar.empty.group' : 'sidebar.empty.dm')
  switch (m.kind) {
    case 'screenshot': {
      const caption = (m.payload as ScreenshotPayload | null)?.caption
      return `📷 ${caption || t('sidebar.preview.screenshot')}`
    }
    case 'approval_request': {
      const p = m.payload as ApprovalPayload | null
      return p?.rule
        ? `✓ ${t('sidebar.preview.byRule', { action: p.action })}`
        : `⏸ ${t('sidebar.preview.needsYou', { action: p?.action ?? t('sidebar.preview.anAction') })}`
    }
    case 'question': {
      const p = m.payload as QuestionPayload | null
      return p?.status === 'open' ? `❓ ${p.question}` : `✓ ${p?.answer?.join(', ') ?? p?.question ?? t('sidebar.preview.answered')}`
    }
    case 'approval_resolved': {
      const p = m.payload as ApprovalResolvedPayload | null
      return `${p?.decision === 'approve' ? '✓' : '✕'} ${p?.action ?? t('sidebar.preview.decided')}`
    }
    case 'memory_updated': {
      const p = m.payload as MemoryPayload | null
      if (!p?.rule) return `🧠 ${t('sidebar.preview.memoryUpdated')}`
      return `🧠 ${p.removed ? t('sidebar.preview.forgot', { rule: p.rule }) : p.rule}`
    }
    case 'routine_created':
      return `🕐 ${(m.payload as RoutinePayload | null)?.name ?? t('sidebar.preview.routineCreated')}`
    case 'bot_ref':
      return `↪ ${t('sidebar.preview.from', { name: (m.payload as BotRefPayload | null)?.fromName ?? t('sidebar.preview.aTeammate') })}`
    case 'webhook':
      return `⇣ ${t('sidebar.preview.webhook', { name: (m.payload as WebhookPayload | null)?.name ?? t('sidebar.preview.aRoutine') })}`
    case 'login_request':
      return `🔑 ${t('sidebar.preview.signIn', { site: (m.payload as LoginPayload | null)?.site ?? t('sidebar.preview.aSite') })}`
    case 'activity': {
      const steps = (m.payload as ActivityPayload | null)?.steps ?? []
      const last = steps[steps.length - 1]
      return last ? `⚙ ${last.tool} ${last.summary}` : `⚙ ${t('sidebar.preview.working')}`
    }
    case 'report': {
      const payload = m.payload as ReportPayload | null
      const first = payload?.lines[0]
      return payload?.closing ?? (first ? `✓ ${first.system} → ${first.result}` : t('sidebar.preview.reportFiled'))
    }
    default:
      if (m.kind === 'text' && isNotice(m.payload)) {
        const n = m.payload
        return n.notice === 'paused' && n.lead ? n.lead : noticeText(t, n)
      }
      return m.content
  }
}

export function Sidebar({ conversations, selectedId, statuses, onSelect, onNewBot }: {
  conversations: Conversation[]
  selectedId: string | null
  statuses: Record<string, BotStatus>
  onSelect: (id: string) => void
  onNewBot: () => void
}) {
  const t = useT()
  const stateText = (state: BotStatus) => { const key = STATE_TEXT[state]; return key ? t(key) : undefined }
  return (
    <aside className="sidebar">
      <div className="sidebar-title">
        <span>OpenSuperBot</span>
        <button className="sidebar-new" onClick={onNewBot} aria-label={t('sidebar.hire')} title={t('sidebar.hire')}>+</button>
      </div>
      {conversations.map((c) => {
        const state = conversationState(c, statuses)
        // 有角标（待批、待答）就已经在说「等你」了；没有角标的等待（比如请你登录）才单独标一句
        const note = state === 'blocked' || state === 'done' || (state === 'waiting' && c.pending === 0)
          ? stateText(state)
          : undefined
        return (
          <button
            key={c.id}
            className={`sidebar-item${c.id === selectedId ? ' selected' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            <span className="avatar" data-state={state} title={stateText(state)}>{c.emoji}</span>
            <span className="sidebar-text">
              <span className="sidebar-name">
                {c.title}{state === 'thinking' ? ' …' : ''}
                {note ? <span className={`sidebar-state ${state}`}>{note}</span> : null}
              </span>
              <span className="sidebar-preview">{preview(c, t)}</span>
            </span>
            {c.pending > 0 ? (
              <span className="sidebar-badge" aria-label={t('sidebar.waitingOnYou', { count: c.pending })}>{c.pending}</span>
            ) : null}
          </button>
        )
      })}
    </aside>
  )
}
