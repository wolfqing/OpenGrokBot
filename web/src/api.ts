import type {
  Bot, BotLlm, CheckResult, ComputerInfo, ConnectionsState, Conversation, FieldError, GatewayEvent, Message, ProviderPreset, RoutineAction,
  RuleDuration,
} from './types'

/** 网关说「先登录」：界面换成锁屏说明，而不是一片空白。 */
export class SignedOut extends Error {
  constructor() { super('sign in first') }
}

/** 网关拒了：message 是它的英文原话，code + params 让界面换成操作者的语言（认得的话） */
export class ApiError extends Error {
  readonly code: string | undefined
  readonly params: Record<string, string | number> | undefined
  readonly status: number
  constructor(message: string, status: number, code?: string, params?: Record<string, string | number>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.params = params
  }
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

/**
 * 默认 409 不算失败：审批被别处先定了、问题已经答过，这种「晚了一步」不值得报错。
 * strict 时 409 也抛：开命令行被拒（没沙箱、自检失败）回的就是 409，原因要摆到面板上。
 */
async function send(method: string, path: string, body?: unknown, opts: { strict?: boolean } = {}): Promise<Response> {
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok && (opts.strict || res.status !== 409)) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; params?: Record<string, string | number> }
    throw new ApiError(data.error ?? `${method} ${path} ${res.status}`, res.status, data.code, data.params)
  }
  return res
}

/** 只有 401 才算「没登录」：网关重启时 dev 代理回的 502 不该把界面锁死 */
export async function checkSession(): Promise<boolean> {
  const res = await fetch('/api/session')
  return res.status !== 401
}

/** 设置里存的界面语言；空串 = 跟浏览器。拿不到（老网关没有这个路由）就当没设 */
export async function fetchLanguage(): Promise<string> {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) return ''
    const body = (await res.json()) as { values?: { language?: unknown } }
    return typeof body.values?.language === 'string' ? body.values.language : ''
  } catch {
    return ''
  }
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

/** 模型连接的表单被网关拒了：每个字段错在哪 */
export class FieldErrors extends Error {
  readonly errors: FieldError[]
  readonly status: number
  constructor(errors: FieldError[], status: number) {
    super(errors.map((e) => `${e.key}: ${e.code}`).join(', ') || `HTTP ${status}`)
    this.name = 'FieldErrors'
    this.errors = errors
    this.status = status
  }
}

async function sendForm<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = (await res.json().catch(() => ({}))) as T & { errors?: FieldError[] }
  if (!res.ok) throw new FieldErrors(Array.isArray(data.errors) ? data.errors : [], res.status)
  return data
}

export type ConnectionFields = {
  name?: string
  provider?: string
  api?: string
  baseURL?: string
  model?: string
  vision?: boolean
  /** 不传 = 不改；空串 = 删掉 */
  apiKey?: string
}

/** 模型连接和每位同事的选择；老网关没有这个路由就是 null（界面不显示这一块） */
export async function fetchConnections(): Promise<ConnectionsState | null> {
  const res = await request('/api/connections')
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /api/connections ${res.status}`)
  return res.json() as Promise<ConnectionsState>
}
export const fetchProviders = () => getJson<ProviderPreset[]>('/api/settings/providers')
export const createConnection = (fields: ConnectionFields) =>
  sendForm<ConnectionsState & { created: string }>('POST', '/api/connections', fields)
export const updateConnection = (id: string, fields: ConnectionFields) =>
  sendForm<ConnectionsState>('PATCH', `/api/connections/${encodeURIComponent(id)}`, fields)
export const deleteConnection = (id: string) =>
  sendForm<ConnectionsState & { moved: string[] }>('DELETE', `/api/connections/${encodeURIComponent(id)}`)
/** 测一个连接；connectionId 给了就从存着的那个出发，其余字段是还没存的改动 */
export const testConnection = (fields: ConnectionFields & { connectionId?: string }) =>
  sendForm<CheckResult>('POST', '/api/connections/test', fields)
export const fetchConnectionModels = (id: string) =>
  getJson<{ ok: true; models: string[] } | { ok: false; code: string }>(`/api/connections/${encodeURIComponent(id)}/models`)
export const setBotLlm = (botId: string, choice: { connectionId: string; model: string | null }) =>
  sendForm<BotLlm>('PUT', `/api/bots/${encodeURIComponent(botId)}/llm`, choice)

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

/** 本机电脑：开关这位同事的命令行（开了也在沙箱里，只能写它自己的文件夹） */
export async function setComputerShell(botId: string, enabled: boolean): Promise<void> {
  await send('PATCH', `/api/bots/${encodeURIComponent(botId)}/computer`, { shell: enabled }, { strict: true })
}

/** 本机电脑：登录完了把浏览器窗口收回后台（shown=false），或主动开出来（shown=true） */
export async function setComputerWindow(botId: string, shown: boolean): Promise<void> {
  await send('POST', `/api/bots/${encodeURIComponent(botId)}/computer/window`, { shown }, { strict: true })
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
