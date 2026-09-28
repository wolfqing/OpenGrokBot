export type ReportLine = { system: string; result: string; count?: string }
export type ReportPayload = { lines: ReportLine[]; closing?: string }
export type ScreenshotPayload = { url: string; width: number; height: number; caption?: string }
export type ApprovalPayload = {
  approvalId: number
  action: string
  detail?: string
  status: 'pending' | 'approved' | 'discarded'
}
export type ApprovalResolvedPayload = { approvalId: number; action: string; decision: 'approve' | 'discard' }
export type MemoryPayload = { rule: string; diff: string; total: number }
export type RoutinePayload = { routineId: number; name: string; cron: string; human: string }
export type BotRefPayload = { from: string; fromName: string; content: string }
export type LoginPayload = { site: string; why?: string }
export type ActivityStep = { tool: string; summary: string; ok?: boolean; ms?: number }
export type ActivityPayload = { steps: ActivityStep[]; done: boolean }

export type ComputerRoutine = {
  id: number
  name: string
  cron: string
  human: string
  last_run_at: number | null
  enabled: number
}

export type UsageTotals = { prompt: number; completion: number; cached: number; total: number }

export type ComputerInfo = {
  botId: string
  running: boolean
  /** 网关给的 noVNC 页面地址，连接参数（含口令）都已带好 */
  vncUrl: string | null
  error?: string
  routines: ComputerRoutine[]
  usage?: { today: UsageTotals; budget: number }
}

export type RoutineAction = 'run' | 'pause' | 'resume' | 'delete'

export type MessageKind =
  | 'text'
  | 'report'
  | 'screenshot'
  | 'approval_request'
  | 'approval_resolved'
  | 'memory_updated'
  | 'routine_created'
  | 'bot_ref'
  | 'login_request'
  | 'activity'

export type Message = {
  id: number
  thread_id: string
  sender: string // 'user' | bot id
  kind: MessageKind
  content: string
  payload:
    | ReportPayload
    | ScreenshotPayload
    | ApprovalPayload
    | ApprovalResolvedPayload
    | MemoryPayload
    | RoutinePayload
    | BotRefPayload
    | LoginPayload
    | ActivityPayload
    | null
  created_at: number
}

export type Conversation = {
  id: string
  kind: 'dm' | 'group'
  title: string
  emoji: string
  subtitle: string
  members: string[]
  last_message: Message | null
  /** 还等着你拍板的审批数 */
  pending: number
}

export type Bot = {
  id: string
  name: string
  role: string
  emoji: string
  thread_id: string
  last_message: Message | null
}

export type BotStatus = 'thinking' | 'idle'

export type GatewayEvent =
  | { type: 'message'; threadId: string; message: Message }
  | { type: 'status'; botId: string; state: BotStatus }
  | { type: 'hello'; statuses: Record<string, BotStatus> }
