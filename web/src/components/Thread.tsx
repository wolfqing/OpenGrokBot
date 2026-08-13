import { useEffect, useRef, useState } from 'react'
import type {
  ApprovalPayload, ApprovalResolvedPayload, Bot, MemoryPayload, Message, ReportPayload, RoutinePayload, ScreenshotPayload,
} from '../types'
import { ApprovalChip } from './ApprovalChip'
import { MemoryChip } from './MemoryChip'
import { ReportChip } from './ReportChip'
import { RoutineChip } from './RoutineChip'
import { ScreenshotChip } from './ScreenshotChip'

export function Thread({ bot, messages, thinking, onSend, onDecide }: {
  bot: Bot
  messages: Message[]
  thinking: boolean
  onSend: (text: string) => void
  onDecide: (approvalId: number, decision: 'approve' | 'discard') => void
}) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, thinking])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onSend(text)
  }

  const renderBody = (m: Message) => {
    if (!m.payload) return <div className="bubble">{m.content}</div>
    switch (m.kind) {
      case 'report': return <ReportChip payload={m.payload as ReportPayload} />
      case 'screenshot': return <ScreenshotChip payload={m.payload as ScreenshotPayload} />
      case 'approval_request': return <ApprovalChip payload={m.payload as ApprovalPayload} onDecide={onDecide} />
      case 'memory_updated': return <MemoryChip payload={m.payload as MemoryPayload} />
      case 'routine_created': return <RoutineChip payload={m.payload as RoutinePayload} />
      case 'approval_resolved': {
        const p = m.payload as ApprovalResolvedPayload
        return <div className="decision">{p.decision === 'approve' ? '✓ Approved' : '✕ Discarded'} · {p.action}</div>
      }
      default: return <div className="bubble">{m.content}</div>
    }
  }

  const rowClass = (m: Message) =>
    m.kind === 'approval_resolved' ? 'centered' : m.sender === 'user' ? 'from-user' : 'from-bot'

  return (
    <main className="thread">
      <header className="thread-header">
        <span className="avatar">{bot.emoji}</span>
        <span className="thread-name">{bot.name}</span>
        {bot.role ? <span className="thread-role">{bot.role}</span> : null}
      </header>
      <div className="thread-scroll" ref={scrollRef}>
        {messages.map((m) => (
          <div key={m.id} className={`row ${rowClass(m)}`}>
            {renderBody(m)}
          </div>
        ))}
        {thinking ? <div className="row from-bot"><div className="bubble typing">•••</div></div> : null}
      </div>
      <footer className="composer">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          placeholder={`Message ${bot.name}`}
        />
        <button onClick={submit} disabled={!draft.trim()} aria-label="Send">↑</button>
      </footer>
    </main>
  )
}
