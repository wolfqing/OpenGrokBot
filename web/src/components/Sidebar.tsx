import type {
  ActivityPayload, ApprovalPayload, ApprovalResolvedPayload, BotRefPayload, BotStatus, Conversation, LoginPayload,
  MemoryPayload, QuestionPayload, ReportPayload, RoutinePayload, ScreenshotPayload, WebhookPayload,
} from '../types'

/**
 * 单聊就是那位同事的状态。群只说「有人在干活」：等你、卡住、刚干完说的是某一位同事，
 * 该在它自己那一行出现，挂在群上会让人点进群里找一件不在群里的事。
 */
export function conversationState(c: Conversation, statuses: Record<string, BotStatus>): BotStatus {
  if (c.kind === 'dm') return statuses[c.members[0] ?? ''] ?? 'idle'
  return c.members.some((id) => statuses[id] === 'thinking') ? 'thinking' : 'idle'
}

const STATE_TEXT: Partial<Record<BotStatus, string>> = {
  thinking: 'working', waiting: 'needs you', blocked: 'stuck', done: 'done',
}

function preview(c: Conversation): string {
  const m = c.last_message
  if (!m) return c.kind === 'group' ? 'Ask the room.' : 'Say hi — first briefing.'
  switch (m.kind) {
    case 'screenshot': {
      const caption = (m.payload as ScreenshotPayload | null)?.caption
      return caption ? `📷 ${caption}` : '📷 Screenshot'
    }
    case 'approval_request': {
      const p = m.payload as ApprovalPayload | null
      return p?.rule ? `✓ ${p.action} (your rule)` : `⏸ Needs you: ${p?.action ?? 'an action'}`
    }
    case 'question': {
      const p = m.payload as QuestionPayload | null
      return p?.status === 'open' ? `❓ ${p.question}` : `✓ ${p?.answer?.join(', ') ?? p?.question ?? 'Answered'}`
    }
    case 'approval_resolved': {
      const p = m.payload as ApprovalResolvedPayload | null
      return `${p?.decision === 'approve' ? '✓' : '✕'} ${p?.action ?? 'decided'}`
    }
    case 'memory_updated': {
      const p = m.payload as MemoryPayload | null
      return `🧠 ${p?.removed ? 'Forgot: ' : ''}${p?.rule ?? 'Memory updated'}`
    }
    case 'routine_created':
      return `🕐 ${(m.payload as RoutinePayload | null)?.name ?? 'Routine created'}`
    case 'bot_ref':
      return `↪ from @${(m.payload as BotRefPayload | null)?.fromName ?? 'a teammate'}`
    case 'webhook':
      return `⇣ Webhook: ${(m.payload as WebhookPayload | null)?.name ?? 'a routine'}`
    case 'login_request':
      return `🔑 Sign in to ${(m.payload as LoginPayload | null)?.site ?? 'a site'}`
    case 'activity': {
      const steps = (m.payload as ActivityPayload | null)?.steps ?? []
      const last = steps[steps.length - 1]
      return last ? `⚙ ${last.tool} ${last.summary}` : '⚙ Working'
    }
    case 'report': {
      const payload = m.payload as ReportPayload | null
      const first = payload?.lines[0]
      return payload?.closing ?? (first ? `✓ ${first.system} → ${first.result}` : 'Report filed.')
    }
    default:
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
  return (
    <aside className="sidebar">
      <div className="sidebar-title">
        <span>OpenGrokBot</span>
        <button className="sidebar-new" onClick={onNewBot} aria-label="Hire a teammate" title="Hire a teammate">+</button>
      </div>
      {conversations.map((c) => {
        const state = conversationState(c, statuses)
        // 有角标（待批、待答）就已经在说「等你」了；没有角标的等待（比如请你登录）才单独标一句
        const note = state === 'blocked' || state === 'done' || (state === 'waiting' && c.pending === 0)
          ? STATE_TEXT[state]
          : undefined
        return (
          <button
            key={c.id}
            className={`sidebar-item${c.id === selectedId ? ' selected' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            <span className="avatar" data-state={state} title={STATE_TEXT[state]}>{c.emoji}</span>
            <span className="sidebar-text">
              <span className="sidebar-name">
                {c.title}{state === 'thinking' ? ' …' : ''}
                {note ? <span className={`sidebar-state ${state}`}>{note}</span> : null}
              </span>
              <span className="sidebar-preview">{preview(c)}</span>
            </span>
            {c.pending > 0 ? (
              <span className="sidebar-badge" aria-label={`${c.pending} waiting on you`}>{c.pending}</span>
            ) : null}
          </button>
        )
      })}
    </aside>
  )
}
