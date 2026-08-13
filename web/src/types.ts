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

export type ComputerRoutine = {
  id: number
  name: string
  cron: string
  human: string
  last_run_at: number | null
}

export type ComputerInfo = {
  botId: string
  running: boolean
  vncUrl: string | null
  error?: string
  routines: ComputerRoutine[]
}

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
