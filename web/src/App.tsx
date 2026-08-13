import { useEffect, useMemo, useRef, useState } from 'react'
import {
  connectEvents, createBot, fetchBots, fetchComputer, fetchConversations, fetchMessages, resolveApproval, sendMessage,
} from './api'
import { ComputerPanel } from './components/ComputerPanel'
import { NewBotForm } from './components/NewBotForm'
import { Sidebar } from './components/Sidebar'
import { Thread } from './components/Thread'
import type { BotStatus, ComputerInfo, Conversation, Message } from './types'

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [roster, setRoster] = useState<Record<string, { name: string; emoji: string }>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [statuses, setStatuses] = useState<Record<string, BotStatus>>({})
  const [panel, setPanel] = useState<ComputerInfo | null>(null)
  const [hiring, setHiring] = useState(false)

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  )
  const threadId = selected?.id ?? null
  const threadIdRef = useRef<string | null>(null)
  useEffect(() => { threadIdRef.current = threadId }, [threadId])

  const loadRoster = () => fetchBots().then((bs) => {
    setRoster(Object.fromEntries(bs.map((b) => [b.id, { name: b.name, emoji: b.emoji }])))
  })

  useEffect(() => {
    fetchConversations().then((cs) => {
      setConversations(cs)
      setSelectedId((id) => id ?? cs[0]?.id ?? null)
    }).catch(console.error)
    // 群里要按 id 显示说话人，所以单独拉一份名册
    void loadRoster().catch(console.error)
  }, [])

  useEffect(() => {
    if (!threadId) return
    let alive = true
    fetchMessages(threadId).then((ms) => { if (alive) setMessages(ms) }).catch(console.error)
    return () => { alive = false }
  }, [threadId])

  useEffect(() => connectEvents((e) => {
    if (e.type === 'status') {
      setStatuses((s) => ({ ...s, [e.botId]: e.state }))
      return
    }
    setConversations((cs) => cs.map((c) => (c.id === e.threadId ? { ...c, last_message: e.message } : c)))
    if (e.threadId === threadIdRef.current) {
      // 同 id 就替换：审批 chip 被放行后网关会重播它，状态要就地翻转
      setMessages((ms) => {
        const at = ms.findIndex((m) => m.id === e.message.id)
        if (at === -1) return [...ms, e.message]
        const next = [...ms]
        next[at] = e.message
        return next
      })
    }
  }), [])

  const openScreen = async () => {
    if (!selected || selected.kind !== 'dm') return
    const botId = selected.members[0]
    if (!botId) return
    try {
      setPanel(await fetchComputer(botId))
    } catch (err) {
      console.error(err)
    }
  }

  const hire = async (name: string, role: string) => {
    try {
      const bot = await createBot(name, role)
      setHiring(false)
      setConversations(await fetchConversations())
      setSelectedId(`dm:${bot.id}`)
      await loadRoster()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  const thinking = selected ? selected.members.some((id) => statuses[id] === 'thinking') : false

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        selectedId={selectedId}
        statuses={statuses}
        onSelect={setSelectedId}
        onNewBot={() => setHiring(true)}
      />
      {selected ? (
        <Thread
          conversation={selected}
          messages={messages}
          thinking={thinking}
          roster={roster}
          onSend={(text) => { if (threadId) void sendMessage(threadId, text) }}
          onDecide={(approvalId, decision) => { void resolveApproval(approvalId, decision) }}
          onOpenScreen={() => { void openScreen() }}
        />
      ) : (
        <main className="thread thread-empty">No teammates yet.</main>
      )}
      {panel ? <ComputerPanel info={panel} botName={selected?.title ?? ''} onClose={() => setPanel(null)} /> : null}
      {hiring ? (
        <div className="modal-scrim" onClick={() => setHiring(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Hire a teammate</div>
            <NewBotForm onCreate={(n, r) => void hire(n, r)} onCancel={() => setHiring(false)} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
