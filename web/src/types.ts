export type ReportLine = { system: string; result: string; count?: string }
export type ReportPayload = { lines: ReportLine[]; closing?: string }
export type ScreenshotPayload = { url: string; width: number; height: number; caption?: string }
/** 「以后这类都放」能管多久：一小时、一天、直到你撤销 */
export type RuleDuration = '1h' | '24h' | 'always'
export type ApprovalPayload = {
  approvalId: number
  action: string
  detail?: string
  status: 'pending' | 'approved' | 'discarded'
  /** bot 申报的类别和去向；老 chip 没有 */
  kind?: string
  target?: string
  /** 这次放行能不能顺手记成规则（花钱、订东西、没有去向的都不行） */
  canRemember?: boolean
  /** 一条已有的规则直接放行了它 */
  rule?: { id: number; kind: string; target: string; expiresAt: number | null }
  /** 你放行时顺手留下的规则 */
  remembered?: { id: number; expiresAt: number | null }
}
export type ApprovalResolvedPayload = {
  approvalId: number
  action: string
  decision: 'approve' | 'discard'
  remembered?: { id: number; expiresAt: number | null; kind: string; target: string }
}
export type MemoryPayload = { rule: string; diff: string; total: number; removed?: boolean; by?: 'operator' }
export type RoutinePayload = { routineId: number; name: string; cron: string; human: string; webhook?: boolean }
export type QuestionPayload = {
  question: string
  options: string[]
  multi: boolean
  /** skipped = 你没点选项、直接打字回了 */
  status: 'open' | 'answered' | 'skipped'
  answer?: string[]
}
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
  /** 带密钥的 webhook 路径（以 / 开头）；没有 webhook 就是 null */
  webhook_path?: string | null
}

export type ApprovalRule = { id: number; kind: string; target: string; expiresAt: number | null; createdAt: number }

export type UsageTotals = { prompt: number; completion: number; cached: number; total: number }

export type ComputerInfo = {
  botId: string
  running: boolean
  /** 网关给的 noVNC 页面地址，连接参数（含口令）都已带好 */
  vncUrl: string | null
  error?: string
  routines: ComputerRoutine[]
  usage?: { today: UsageTotals; budget: number }
  /** 还在生效的「以后都放行」 */
  rules?: ApprovalRule[]
  /** MEMORY.md 里的规矩，一条一行 */
  memory?: string[]
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
  | 'question'

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
    | QuestionPayload
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

/**
 * 网关给的：thinking 在干活、waiting 在等你、blocked 卡住了、idle 闲着。
 * done 是界面自己记的：它在你没看着的时候干完了一件事，点开它的线程就消掉。
 */
export type BotStatus = 'thinking' | 'waiting' | 'blocked' | 'idle' | 'done'

export type GatewayEvent =
  | { type: 'message'; threadId: string; message: Message }
  | { type: 'status'; botId: string; state: BotStatus }
  | { type: 'hello'; statuses: Record<string, BotStatus> }
