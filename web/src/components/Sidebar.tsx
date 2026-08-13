import type {
  ApprovalPayload, ApprovalResolvedPayload, BotRefPayload, BotStatus, Conversation, MemoryPayload,
  ReportPayload, RoutinePayload, ScreenshotPayload,
} from '../types'

function preview(c: Conversation): string {
  const m = c.last_message
  if (!m) return c.kind === 'group' ? 'Ask the room.' : 'Say hi — first briefing.'
  switch (m.kind) {
    case 'screenshot': {
      const caption = (m.payload as ScreenshotPayload | null)?.caption
      return caption ? `📷 ${caption}` : '📷 Screenshot'
    }
    case 'approval_request':
      return `⏸ Needs you: ${(m.payload as ApprovalPayload | null)?.action ?? 'an action'}`
    case 'approval_resolved': {
      const p = m.payload as ApprovalResolvedPayload | null
      return `${p?.decision === 'approve' ? '✓' : '✕'} ${p?.action ?? 'decided'}`
    }
    case 'memory_updated':
      return `🧠 ${(m.payload as MemoryPayload | null)?.rule ?? 'Memory updated'}`
    case 'routine_created':
      return `🕐 ${(m.payload as RoutinePayload | null)?.name ?? 'Routine created'}`
    case 'bot_ref':
      return `↪ from @${(m.payload as BotRefPayload | null)?.fromName ?? 'a teammate'}`
    case 'report': {
      const payload = m.payload as ReportPayload | null
      const first = payload?.lines[0]
      return payload?.closing ?? (first ? `✓ ${first.system} → ${first.result}` : 'Report filed.')
    }
    default:
      return m.content
  }
}

export function Sidebar({ conversations, selectedId, statuses, onSelect }: {
  conversations: Conversation[]
  selectedId: string | null
  statuses: Record<string, BotStatus>
  onSelect: (id: string) => void
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-title">OpenGrokBot</div>
      {conversations.map((c) => (
        <button
          key={c.id}
          className={`sidebar-item${c.id === selectedId ? ' selected' : ''}`}
          onClick={() => onSelect(c.id)}
        >
          <span className="avatar">{c.emoji}</span>
          <span className="sidebar-text">
            <span className="sidebar-name">
              {c.title}{c.members.some((id) => statuses[id] === 'thinking') ? ' …' : ''}
            </span>
            <span className="sidebar-preview">{preview(c)}</span>
          </span>
        </button>
      ))}
    </aside>
  )
}
