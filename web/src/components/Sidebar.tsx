import type {
  ApprovalPayload, ApprovalResolvedPayload, Bot, BotStatus, MemoryPayload, ReportPayload, RoutinePayload, ScreenshotPayload,
} from '../types'

function preview(bot: Bot): string {
  const m = bot.last_message
  if (!m) return 'Say hi — first briefing.'
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
    case 'report': {
      const payload = m.payload as ReportPayload | null
      const first = payload?.lines[0]
      return payload?.closing ?? (first ? `✓ ${first.system} → ${first.result}` : 'Report filed.')
    }
    default:
      return m.content
  }
}

export function Sidebar({ bots, selectedId, statuses, onSelect }: {
  bots: Bot[]
  selectedId: string | null
  statuses: Record<string, BotStatus>
  onSelect: (id: string) => void
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-title">OpenGrokBot</div>
      {bots.map((b) => (
        <button
          key={b.id}
          className={`sidebar-item${b.id === selectedId ? ' selected' : ''}`}
          onClick={() => onSelect(b.id)}
        >
          <span className="avatar">{b.emoji}</span>
          <span className="sidebar-text">
            <span className="sidebar-name">{b.name}{statuses[b.id] === 'thinking' ? ' …' : ''}</span>
            <span className="sidebar-preview">{preview(b)}</span>
          </span>
        </button>
      ))}
    </aside>
  )
}
