import { useEffect, useRef, useState } from 'react'
import type { Bot, Message } from '../types'
import { ReportChip } from './ReportChip'

export function Thread({ bot, messages, thinking, onSend }: {
  bot: Bot
  messages: Message[]
  thinking: boolean
  onSend: (text: string) => void
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

  return (
    <main className="thread">
      <header className="thread-header">
        <span className="avatar">{bot.emoji}</span>
        <span className="thread-name">{bot.name}</span>
        {bot.role ? <span className="thread-role">{bot.role}</span> : null}
      </header>
      <div className="thread-scroll" ref={scrollRef}>
        {messages.map((m) => (
          <div key={m.id} className={`row ${m.sender === 'user' ? 'from-user' : 'from-bot'}`}>
            {m.kind === 'report' && m.payload
              ? <ReportChip payload={m.payload} />
              : <div className="bubble">{m.content}</div>}
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
