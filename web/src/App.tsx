import { useEffect, useMemo, useRef, useState } from 'react'
import { connectEvents, fetchBots, fetchMessages, sendMessage } from './api'
import { Sidebar } from './components/Sidebar'
import { Thread } from './components/Thread'
import type { Bot, BotStatus, Message } from './types'

export default function App() {
  const [bots, setBots] = useState<Bot[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [statuses, setStatuses] = useState<Record<string, BotStatus>>({})

  const selected = useMemo(() => bots.find((b) => b.id === selectedId) ?? null, [bots, selectedId])
  const threadId = selected?.thread_id ?? null
  const threadIdRef = useRef<string | null>(null)
  useEffect(() => { threadIdRef.current = threadId }, [threadId])

  useEffect(() => {
    fetchBots().then((bs) => {
      setBots(bs)
      setSelectedId((id) => id ?? bs[0]?.id ?? null)
    }).catch(console.error)
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
    setBots((bs) => bs.map((b) => (b.thread_id === e.threadId ? { ...b, last_message: e.message } : b)))
    if (e.threadId === threadIdRef.current) {
      setMessages((ms) => (ms.some((m) => m.id === e.message.id) ? ms : [...ms, e.message]))
    }
  }), [])

  return (
    <div className="app">
      <Sidebar bots={bots} selectedId={selectedId} statuses={statuses} onSelect={setSelectedId} />
      {selected ? (
        <Thread
          bot={selected}
          messages={messages}
          thinking={statuses[selected.id] === 'thinking'}
          onSend={(text) => { if (threadId) void sendMessage(threadId, text) }}
        />
      ) : (
        <main className="thread thread-empty">No teammates yet.</main>
      )}
    </div>
  )
}
