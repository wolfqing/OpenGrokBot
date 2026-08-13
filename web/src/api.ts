import type { Bot, ComputerInfo, Conversation, GatewayEvent, Message } from './types'

export async function fetchBots(): Promise<Bot[]> {
  const res = await fetch('/api/bots')
  if (!res.ok) throw new Error(`GET /api/bots ${res.status}`)
  return res.json()
}

export async function fetchConversations(): Promise<Conversation[]> {
  const res = await fetch('/api/conversations')
  if (!res.ok) throw new Error(`GET /api/conversations ${res.status}`)
  return res.json()
}

export async function fetchMessages(threadId: string): Promise<Message[]> {
  const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/messages`)
  if (!res.ok) throw new Error(`GET messages ${res.status}`)
  return res.json()
}

export async function sendMessage(threadId: string, text: string): Promise<void> {
  await fetch(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

export async function fetchComputer(botId: string): Promise<ComputerInfo> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/computer`)
  if (!res.ok) throw new Error(`GET computer ${res.status}`)
  return res.json()
}

export async function createBot(name: string, role: string): Promise<Bot> {
  const res = await fetch('/api/bots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, role }),
  })
  const data = (await res.json()) as Bot & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `POST /api/bots ${res.status}`)
  return data
}

export async function resolveApproval(approvalId: number, decision: 'approve' | 'discard'): Promise<void> {
  await fetch(`/api/approvals/${approvalId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  })
}

export function connectEvents(onEvent: (e: GatewayEvent) => void): () => void {
  let ws: WebSocket | null = null
  let closed = false
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    ws.onmessage = (ev) => {
      try { onEvent(JSON.parse(ev.data)) } catch { /* 忽略脏帧 */ }
    }
    ws.onclose = () => { if (!closed) setTimeout(open, 1500) }
  }
  open()
  return () => { closed = true; ws?.close() }
}
