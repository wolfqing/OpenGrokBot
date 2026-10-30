import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type {
  ActivityPayload, ApprovalPayload, ApprovalResolvedPayload, BotRefPayload, Conversation, LoginPayload, MemoryPayload,
  Message, QuestionPayload, ReportPayload, RoutinePayload, RuleDuration, ScreenshotPayload, WebhookPayload,
} from '../types'
import { ActivityChip } from './ActivityChip'
import { ApprovalChip } from './ApprovalChip'
import { BotRefChip } from './BotRefChip'
import { LoginChip } from './LoginChip'
import { Markdown } from './Markdown'
import { MemoryChip } from './MemoryChip'
import { QuestionChip } from './QuestionChip'
import { ReportChip } from './ReportChip'
import { RoutineChip } from './RoutineChip'
import { ScreenshotChip } from './ScreenshotChip'
import { WebhookChip } from './WebhookChip'

/** 停顿超过这么久，下一条消息前再标一次时间；连珠炮式的往来只在开头标一次。 */
const TIME_GAP_MS = 5 * 60_000
const dayKey = (ts: number) => new Date(ts).toDateString()

function dayLabel(ts: number, now: Date): string {
  const key = dayKey(ts)
  if (key === now.toDateString()) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (key === yesterday.toDateString()) return 'Yesterday'
  const day = new Date(ts)
  return day.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

const timeLabel = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export function Thread({ conversation, messages, thinking, onSend, onDecide, onAnswer, roster, onOpenScreen, onStop }: {
  conversation: Conversation
  messages: Message[]
  thinking: boolean
  onSend: (text: string) => void
  onDecide: (approvalId: number, decision: 'approve' | 'discard', remember?: RuleDuration, items?: number[]) => void
  /** 问题卡片上点了选项 */
  onAnswer?: (messageId: number, choices: string[]) => void | Promise<void>
  roster: Record<string, { name: string; emoji: string }>
  onOpenScreen?: () => void
  onStop?: () => void
}) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  // 往上翻着看历史时，新消息不该把人拽回底部；换了线程就重新贴底
  const pinned = useRef(true)
  useEffect(() => { pinned.current = true }, [conversation.id])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, thinking])

  // 输入框随内容长高，最多八行左右
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    box.style.height = 'auto'
    // border-box：高度要把上下边框也算进去，否则会凭空冒出滚动条
    const wanted = box.scrollHeight + box.offsetHeight - box.clientHeight
    box.style.height = `${Math.min(wanted, 180)}px`
    box.style.overflowY = wanted > 180 ? 'auto' : 'hidden'
  }, [draft])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    pinned.current = true
    onSend(text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    // 输入法正在选字时的回车是「上屏」，不是「发送」；Safari 在 compositionend 之后才补发 keyCode 229
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    submit()
  }

  const renderBody = (m: Message) => {
    // 同事的话按 markdown 显示（模型天然写 markdown）；你自己打的字照原样显示，星号就是星号
    if (!m.payload) {
      return m.sender === 'user'
        ? <div className="bubble">{m.content}</div>
        : <div className="bubble markdown"><Markdown text={m.content} /></div>
    }
    switch (m.kind) {
      case 'report': return <ReportChip payload={m.payload as ReportPayload} />
      case 'screenshot': return <ScreenshotChip payload={m.payload as ScreenshotPayload} />
      case 'approval_request': return <ApprovalChip payload={m.payload as ApprovalPayload} onDecide={onDecide} />
      case 'memory_updated': return <MemoryChip payload={m.payload as MemoryPayload} />
      case 'routine_created': return <RoutineChip payload={m.payload as RoutinePayload} />
      case 'bot_ref': return <BotRefChip payload={m.payload as BotRefPayload} />
      case 'login_request':
        return <LoginChip payload={m.payload as LoginPayload} onOpenScreen={() => onOpenScreen?.()} />
      case 'activity': return <ActivityChip payload={m.payload as ActivityPayload} />
      case 'webhook': return <WebhookChip payload={m.payload as WebhookPayload} />
      case 'question':
        return <QuestionChip payload={m.payload as QuestionPayload} onAnswer={(choices) => onAnswer?.(m.id, choices)} />
      case 'approval_resolved': {
        const p = m.payload as ApprovalResolvedPayload
        return (
          <div className="decision">
            {p.decision === 'approve' ? '✓ Approved' : '✕ Discarded'} · {p.action}
            {p.count ? ` · ${p.count.approved} of ${p.count.of} items` : ''}
            {p.remembered ? ` · rule saved: ${p.remembered.kind} → ${p.remembered.target}` : ''}
          </div>
        )
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

  const now = new Date()

  return (
    <main className="thread">
      <header className="thread-header">
        <span className="avatar">{conversation.emoji}</span>
        <span className="thread-name">{conversation.title}</span>
        {conversation.subtitle ? <span className="thread-role">{conversation.subtitle}</span> : null}
        {conversation.kind === 'dm' && onOpenScreen ? (
          <button className="screen-button" onClick={onOpenScreen} aria-label="Open its computer" title="Open its computer">
            🖥️
          </button>
        ) : null}
      </header>
      <div
        className="thread-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at)
          const showTime = newDay || m.created_at - prev.created_at > TIME_GAP_MS
          const speaker = speakerOf(m)
          const at = new Date(m.created_at)
          return (
            <Fragment key={m.id}>
              {newDay ? <div className="day-divider" role="separator">{dayLabel(m.created_at, now)}</div> : null}
              <div className={`row ${rowClass(m)}`}>
                <div className="row-inner">
                  {speaker || showTime ? (
                    <div className="row-meta">
                      {speaker ? (
                        <span className="speaker">
                          <span className="speaker-emoji">{speaker.emoji}</span>
                          <span className="speaker-name">{speaker.name}</span>
                        </span>
                      ) : null}
                      {showTime ? (
                        <time className="row-time" dateTime={at.toISOString()} title={at.toLocaleString()}>
                          {timeLabel(m.created_at)}
                        </time>
                      ) : null}
                    </div>
                  ) : null}
                  {renderBody(m)}
                </div>
              </div>
            </Fragment>
          )
        })}
        {thinking ? <div className="row from-bot"><div className="bubble typing">•••</div></div> : null}
      </div>
      <footer className="composer">
        <textarea
          ref={boxRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${conversation.title}`}
        />
        {thinking && onStop ? (
          <button className="composer-stop" onClick={onStop} aria-label="Stop" title="Stop what it is doing">■</button>
        ) : null}
        <button className="composer-send" onClick={submit} disabled={!draft.trim()} aria-label="Send">↑</button>
      </footer>
    </main>
  )
}
