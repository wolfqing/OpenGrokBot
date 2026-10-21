import type { Bot, ComputerInfo, Conversation, GatewayEvent, Message, RoutineAction, RuleDuration } from './types'

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

/** 只有 401 才算「没登录」：网关重启时 dev 代理回的 502 不该把界面锁死 */
export async function checkSession(): Promise<boolean> {
  const res = await fetch('/api/session')
  return res.status !== 401
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

/** items：一批对象里只放行这几项（下标）；不传 = 全部 */
export async function resolveApproval(
  approvalId: number,
  decision: 'approve' | 'discard',
  remember?: RuleDuration,
  items?: number[],
): Promise<void> {
  await send('POST', `/api/approvals/${approvalId}`, {
    decision, ...(remember ? { remember } : {}), ...(items ? { items } : {}),
  })
}

export async function answerQuestion(messageId: number, choices: string[]): Promise<void> {
  await send('POST', `/api/questions/${messageId}`, { choices })
}

export async function revokeRule(id: number): Promise<void> {
  await send('DELETE', `/api/rules/${id}`)
}

export async function forgetMemoryRule(botId: string, rule: string): Promise<void> {
  await send('POST', `/api/bots/${encodeURIComponent(botId)}/memory/forget`, { rule })
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
