import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SignedOut, answerQuestion, checkSession, connectEvents, createBot, fetchBots, fetchComputer, fetchConversations,
  fetchMessages, forgetMemoryRule, resolveApproval, revokeRule, sendMessage, stopThread, updateRoutine,
} from './api'
import { ComputerPanel } from './components/ComputerPanel'
import { NewBotForm } from './components/NewBotForm'
import { Sidebar } from './components/Sidebar'
import { Thread } from './components/Thread'
import { applyHello, applyStatus, clearDone } from './presence'
import type { BotStatus, ComputerInfo, Conversation, Message, RoutineAction } from './types'

/** 网关锁着：告诉人去哪拿登录链接，而不是一片空白。 */
function SignIn() {
  return (
    <main className="signin">
      <div className="signin-card">
        <div className="signin-title">This gateway is locked</div>
        <p>
          Open the sign-in link the gateway printed when it started. It looks like{' '}
          <code>{location.origin}/auth?token=…</code> and signs this browser in for a year.
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
  /** 电脑面板开给谁；info 为 null 表示那台电脑还在醒 */
  const [panel, setPanel] = useState<{ botId: string; info: ComputerInfo | null } | null>(null)
  const [hiring, setHiring] = useState(false)
  const [hireError, setHireError] = useState<string | undefined>()

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  )
  const threadId = selected?.id ?? null
  const threadIdRef = useRef<string | null>(null)
  useEffect(() => { threadIdRef.current = threadId }, [threadId])
  // 正看着的线程里有谁：他们干完了你自己看得见，不用再标「done」；点开的那一刻把已有的「done」消掉
  const watchingRef = useRef<string[]>([])
  const members = selected?.members.join(',') ?? ''
  useEffect(() => {
    const ids = members ? members.split(',') : []
    watchingRef.current = ids
    setStatuses((s) => clearDone(s, ids))
  }, [members])
  // 面板此刻属于谁，同步记在 ref 里：拉起电脑要十几秒，结果回来时人可能早换了线程或关了面板
  const panelFor = useRef<string | null>(null)
  const showPanel = useCallback((next: { botId: string; info: ComputerInfo | null } | null) => {
    panelFor.current = next?.botId ?? null
    setPanel(next)
  }, [])
  // 面板属于某一位同事：换了线程就收起，免得新名字盖在旧屏幕上
  useEffect(() => { showPanel(null) }, [selectedId, showPanel])

  /** 拉消息期间经 WS 到达的更新先记下来，拉回来后叠在快照上，免得被旧快照覆盖掉 */
  const liveDuringFetch = useRef<Map<number, Message> | null>(null)
  const loadMessages = useCallback(async (thread: string) => {
    liveDuringFetch.current = new Map()
    try {
      const fetched = await fetchMessages(thread)
      const live = liveDuringFetch.current ?? new Map<number, Message>()
      if (threadIdRef.current !== thread) return
      const merged = fetched.map((m) => live.get(m.id) ?? m)
      const known = new Set(merged.map((m) => m.id))
      for (const m of live.values()) if (!known.has(m.id)) merged.push(m)
      setMessages(merged.sort((a, b) => a.id - b.id))
    } finally {
      liveDuringFetch.current = null
    }
  }, [])

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
      if (current) await loadMessages(current)
    } catch (err) {
      guard(err)
    }
  }, [guard, loadMessages, loadRoster, refreshConversations])

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
    setMessages([])
    loadMessages(threadId).catch(guard)
  }, [threadId, guard, loadMessages])

  useEffect(() => {
    if (signedOut !== false) return
    return connectEvents((e) => {
      if (e.type === 'hello') {
        setStatuses((s) => applyHello(s, e.statuses))
        void resync()
        return
      }
      if (e.type === 'status') {
        setStatuses((s) => applyStatus(s, e.botId, e.state, watchingRef.current.includes(e.botId)))
        return
      }
      // 就地更新的旧消息（activity 卡片收尾、审批 chip 翻转）不该顶掉更新的那条预览
      setConversations((cs) => cs.map((c) => (
        c.id === e.threadId && e.message.id >= (c.last_message?.id ?? 0) ? { ...c, last_message: e.message } : c
      )))
      // 审批、问题来了或定了，侧栏的「等你」计数要跟着变
      if (['approval_request', 'approval_resolved', 'question'].includes(e.message.kind)) {
        void refreshConversations().catch(guard)
      }
      if (e.threadId === threadIdRef.current) {
        liveDuringFetch.current?.set(e.message.id, e.message)
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

  /** 拉一次面板数据；只在面板还开给同一位同事时才放进去 */
  const loadPanel = async (botId: string) => {
    try {
      const info = await fetchComputer(botId)
      if (panelFor.current === botId) showPanel({ botId, info })
    } catch (err) {
      if (panelFor.current === botId) showPanel(null)
      guard(err)
    }
  }

  const openScreen = () => {
    if (!selected || selected.kind !== 'dm') return
    const botId = selected.members[0]
    if (!botId) return
    if (panel?.botId === botId && !panel.info) return // 已经在等它醒了
    // 已经开着就原地刷新，不闪回加载态；没开就先把面板亮出来
    showPanel({ botId, info: panel?.botId === botId ? panel.info : null })
    void loadPanel(botId)
  }

  const onRoutine = async (id: number, action: RoutineAction) => {
    if (action === 'delete' && !window.confirm('Delete this routine? It will not fire again.')) return
    try {
      await updateRoutine(id, action)
      if (panel) await loadPanel(panel.botId)
    } catch (err) {
      guard(err)
    }
  }

  const onRevokeRule = async (id: number) => {
    try {
      await revokeRule(id)
      if (panel) await loadPanel(panel.botId)
    } catch (err) {
      guard(err)
    }
  }

  const onForgetRule = async (rule: string) => {
    if (!panel || !window.confirm(`Forget this rule?\n\n${rule}`)) return
    try {
      await forgetMemoryRule(panel.botId, rule)
      await loadPanel(panel.botId)
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
          onDecide={(approvalId, decision, remember) => { resolveApproval(approvalId, decision, remember).catch(guard) }}
          onAnswer={(messageId, choices) => { answerQuestion(messageId, choices).catch(guard) }}
          onOpenScreen={openScreen}
          onStop={() => { if (threadId) stopThread(threadId).catch(guard) }}
        />
      ) : (
        <main className="thread thread-empty">No teammates yet.</main>
      )}
      {panel ? (
        <ComputerPanel
          info={panel.info}
          botName={selected?.title ?? ''}
          onClose={() => showPanel(null)}
          onRoutine={(id, action) => { void onRoutine(id, action) }}
          onRevokeRule={(id) => { void onRevokeRule(id) }}
          onForgetRule={(rule) => { void onForgetRule(rule) }}
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
