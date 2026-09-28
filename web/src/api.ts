import type { Bot, ComputerInfo, Conversation, GatewayEvent, Message, RoutineAction } from './types'

/** 网关说「先登录」：界面换成锁屏说明，而不是一片空白。 */
export class SignedOut extends Error {
  constructor() { super('sign in first') }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init)
  if (res.status === 401) throw new SignedOut()
  return res
}

async function getJson<T>(path: string): Promise<T> {
  const res = await request(path)
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`)
  return res.json() as Promise<T>
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok && res.status !== 409) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `${method} ${path} ${res.status}`)
  }
  return res
}

export async function checkSession(): Promise<boolean> {
  const res = await fetch('/api/session')
  return res.ok
}

export const fetchBots = () => getJson<Bot[]>('/api/bots')
export const fetchConversations = () => getJson<Conversation[]>('/api/conversations')
export const fetchMessages = (threadId: string) => getJson<Message[]>(`/api/threads/${encodeURIComponent(threadId)}/messages`)
export const fetchComputer = (botId: string) => getJson<ComputerInfo>(`/api/bots/${encodeURIComponent(botId)}/computer`)

export async function sendMessage(threadId: string, text: string): Promise<void> {
  await send('POST', `/api/threads/${encodeURIComponent(threadId)}/messages`, { text })
}

export async function stopThread(threadId: string): Promise<void> {
  await send('POST', `/api/threads/${encodeURIComponent(threadId)}/stop`)
}

export async function createBot(name: string, role: string): Promise<Bot> {
  const res = await send('POST', '/api/bots', { name, role })
  return res.json() as Promise<Bot>
}

export async function resolveApproval(approvalId: number, decision: 'approve' | 'discard'): Promise<void> {
  await send('POST', `/api/approvals/${approvalId}`, { decision })
}

export async function updateRoutine(id: number, action: RoutineAction): Promise<void> {
  if (action === 'run') await send('POST', `/api/routines/${id}/run`)
  else if (action === 'delete') await send('DELETE', `/api/routines/${id}`)
  else await send('PATCH', `/api/routines/${id}`, { enabled: action === 'resume' })
}

/** 断线自动重连；网关每次连上都会先发一份 hello 快照，调用方据此补拉错过的消息。 */
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
