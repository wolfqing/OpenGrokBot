import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SignedOut, checkSession, connectEvents, createBot, fetchBots, fetchComputer, fetchConversations, fetchMessages,
  resolveApproval, sendMessage, stopThread, updateRoutine,
} from './api'
import { ComputerPanel } from './components/ComputerPanel'
import { NewBotForm } from './components/NewBotForm'
import { Sidebar } from './components/Sidebar'
import { Thread } from './components/Thread'
import type { BotStatus, ComputerInfo, Conversation, Message, RoutineAction } from './types'

/** 网关锁着：告诉人去哪拿登录链接，而不是一片空白。 */
function SignIn() {
  return (
    <main className="signin">
      <div className="signin-card">
        <div className="signin-title">This gateway is locked</div>
        <p>
          Open the sign-in link the gateway printed when it started. It looks like{' '}
          <code>http://localhost:5173/auth?token=…</code> and signs this browser in for a year.
        </p>
        <p className="signin-hint">Lost it? The token is in <code>gateway/data/auth-token</code>.</p>
      </div>
    </main>
  )
}

export default function App() {
  const [signedOut, setSignedOut] = useState<boolean | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [roster, setRoster] = useState<Record<string, { name: string; emoji: string }>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [statuses, setStatuses] = useState<Record<string, BotStatus>>({})
  const [panel, setPanel] = useState<ComputerInfo | null>(null)
  const [hiring, setHiring] = useState(false)
  const [hireError, setHireError] = useState<string | undefined>()

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  )
  const threadId = selected?.id ?? null
  const threadIdRef = useRef<string | null>(null)
  useEffect(() => { threadIdRef.current = threadId }, [threadId])

  const guard = useCallback((err: unknown) => {
    if (err instanceof SignedOut) setSignedOut(true)
    else console.error(err)
  }, [])

  const refreshConversations = useCallback(async () => {
    const cs = await fetchConversations()
    setConversations(cs)
    setSelectedId((id) => id ?? cs[0]?.id ?? null)
  }, [])

  const loadRoster = useCallback(async () => {
    const bs = await fetchBots()
    // 群里要按 id 显示说话人，所以单独拉一份名册
    setRoster(Object.fromEntries(bs.map((b) => [b.id, { name: b.name, emoji: b.emoji }])))
  }, [])

  /** 首次加载和每次重连都走这里：断线期间错过的消息、审批数、名册一次补齐。 */
  const resync = useCallback(async () => {
    try {
      await Promise.all([refreshConversations(), loadRoster()])
      const current = threadIdRef.current
      if (current) {
        const ms = await fetchMessages(current)
        if (threadIdRef.current === current) setMessages(ms)
      }
    } catch (err) {
      guard(err)
    }
  }, [guard, loadRoster, refreshConversations])

  useEffect(() => {
    checkSession()
      .then((ok) => {
        setSignedOut(!ok)
        if (ok) void resync()
      })
      .catch(() => setSignedOut(false)) // 网关没起来：先显示空界面，WS 重连上以后会补拉
  }, [resync])

  useEffect(() => {
    if (!threadId) return
    let alive = true
    fetchMessages(threadId).then((ms) => { if (alive) setMessages(ms) }).catch(guard)
    return () => { alive = false }
  }, [threadId, guard])

  useEffect(() => {
    if (signedOut !== false) return
    return connectEvents((e) => {
      if (e.type === 'hello') {
        setStatuses(e.statuses)
        void resync()
        return
      }
      if (e.type === 'status') {
        setStatuses((s) => ({ ...s, [e.botId]: e.state }))
        return
      }
      // 就地更新的旧消息（activity 卡片收尾、审批 chip 翻转）不该顶掉更新的那条预览
      setConversations((cs) => cs.map((c) => (
        c.id === e.threadId && e.message.id >= (c.last_message?.id ?? 0) ? { ...c, last_message: e.message } : c
      )))
      // 审批来了或定了，侧栏的「等你」计数要跟着变
      if (e.message.kind === 'approval_request' || e.message.kind === 'approval_resolved') {
        void refreshConversations().catch(guard)
      }
      if (e.threadId === threadIdRef.current) {
        // 同 id 就替换：审批 chip 被放行、activity 卡片多了一步，都是就地更新
        setMessages((ms) => {
          const at = ms.findIndex((m) => m.id === e.message.id)
          if (at === -1) return [...ms, e.message]
          const next = [...ms]
          next[at] = e.message
          return next
        })
      }
    })
  }, [signedOut, resync, refreshConversations, guard])

  const waiting = conversations.reduce((sum, c) => sum + (c.pending ?? 0), 0)
  useEffect(() => {
    document.title = waiting ? `(${waiting}) OpenGrokBot` : 'OpenGrokBot'
  }, [waiting])

  const openScreen = async () => {
    if (!selected || selected.kind !== 'dm') return
    const botId = selected.members[0]
    if (!botId) return
    try {
      setPanel(await fetchComputer(botId))
    } catch (err) {
      guard(err)
    }
  }

  const onRoutine = async (id: number, action: RoutineAction) => {
    if (action === 'delete' && !window.confirm('Delete this routine? It will not fire again.')) return
    try {
      await updateRoutine(id, action)
      if (panel) setPanel(await fetchComputer(panel.botId))
    } catch (err) {
      guard(err)
    }
  }

  const hire = async (name: string, role: string) => {
    try {
      const bot = await createBot(name, role)
      setHiring(false)
      setHireError(undefined)
      await refreshConversations()
      setSelectedId(`dm:${bot.id}`)
      await loadRoster()
    } catch (err) {
      if (err instanceof SignedOut) setSignedOut(true)
      else setHireError(err instanceof Error ? err.message : String(err))
    }
  }

  if (signedOut) return <SignIn />

  const thinking = selected ? selected.members.some((id) => statuses[id] === 'thinking') : false

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        selectedId={selectedId}
        statuses={statuses}
        onSelect={setSelectedId}
        onNewBot={() => { setHireError(undefined); setHiring(true) }}
      />
      {selected ? (
        <Thread
          conversation={selected}
          messages={messages}
          thinking={thinking}
          roster={roster}
          onSend={(text) => { if (threadId) sendMessage(threadId, text).catch(guard) }}
          onDecide={(approvalId, decision) => { resolveApproval(approvalId, decision).catch(guard) }}
          onOpenScreen={() => { void openScreen() }}
          onStop={() => { if (threadId) stopThread(threadId).catch(guard) }}
        />
      ) : (
        <main className="thread thread-empty">No teammates yet.</main>
      )}
      {panel ? (
        <ComputerPanel
          info={panel}
          botName={selected?.title ?? ''}
          onClose={() => setPanel(null)}
          onRoutine={(id, action) => { void onRoutine(id, action) }}
        />
      ) : null}
      {hiring ? (
        <div className="modal-scrim" onClick={() => setHiring(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Hire a teammate</div>
            <NewBotForm onCreate={(n, r) => void hire(n, r)} onCancel={() => setHiring(false)} error={hireError} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
