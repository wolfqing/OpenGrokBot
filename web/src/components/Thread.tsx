import { useEffect, useRef, useState } from 'react'
import type {
  ApprovalPayload, ApprovalResolvedPayload, BotRefPayload, Conversation, MemoryPayload, Message,
  ReportPayload, RoutinePayload, ScreenshotPayload,
} from '../types'
import { ApprovalChip } from './ApprovalChip'
import { BotRefChip } from './BotRefChip'
import { MemoryChip } from './MemoryChip'
import { ReportChip } from './ReportChip'
import { RoutineChip } from './RoutineChip'
import { ScreenshotChip } from './ScreenshotChip'

export function Thread({ conversation, messages, thinking, onSend, onDecide, roster }: {
  conversation: Conversation
  messages: Message[]
  thinking: boolean
  onSend: (text: string) => void
  onDecide: (approvalId: number, decision: 'approve' | 'discard') => void
  roster: Record<string, { name: string; emoji: string }>
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
      case 'bot_ref': return <BotRefChip payload={m.payload as BotRefPayload} />
      case 'approval_resolved': {
        const p = m.payload as ApprovalResolvedPayload
        return <div className="decision">{p.decision === 'approve' ? '✓ Approved' : '✕ Discarded'} · {p.action}</div>
      }
      default: return <div className="bubble">{m.content}</div>
    }
  }

  const rowClass = (m: Message) =>
    m.kind === 'approval_resolved' ? 'centered' : m.sender === 'user' ? 'from-user' : 'from-bot'

  // 群里必须看得出谁在说话；单聊只有一个对象，加名字反而是噪音
  const speakerOf = (m: Message) =>
    conversation.kind === 'group' && m.sender !== 'user' && m.kind !== 'approval_resolved'
      ? roster[m.sender]
      : undefined

  return (
    <main className="thread">
      <header className="thread-header">
        <span className="avatar">{conversation.emoji}</span>
        <span className="thread-name">{conversation.title}</span>
        {conversation.subtitle ? <span className="thread-role">{conversation.subtitle}</span> : null}
      </header>
      <div className="thread-scroll" ref={scrollRef}>
        {messages.map((m) => {
          const speaker = speakerOf(m)
          return (
            <div key={m.id} className={`row ${rowClass(m)}`}>
              <div className="row-inner">
                {speaker ? (
                  <div className="speaker">
                    <span className="speaker-emoji">{speaker.emoji}</span>
                    <span className="speaker-name">{speaker.name}</span>
                  </div>
                ) : null}
                {renderBody(m)}
              </div>
            </div>
          )
        })}
        {thinking ? <div className="row from-bot"><div className="bubble typing">•••</div></div> : null}
      </div>
      <footer className="composer">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          placeholder={`Message ${conversation.title}`}
        />
        <button onClick={submit} disabled={!draft.trim()} aria-label="Send">↑</button>
      </footer>
    </main>
  )
}
