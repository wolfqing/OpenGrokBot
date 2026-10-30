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
  /** 类别可以记规则、但去向不是一个确定的地方：为什么不给「Always allow」 */
  rememberBlocked?: string
  /** 有规则本来能放行它，但这一回合不是你开的头（或眼前有外部数据），所以还是问了你 */
  ruleHeld?: 'routine' | 'webhook' | 'relay' | 'outside-data' | 'unknown'
  /** 一批对象，一项一行 */
  items?: string[]
  /** 你勾留下、放行了的那几项的下标 */
  approvedItems?: number[]
}
export type ApprovalResolvedPayload = {
  approvalId: number
  action: string
  decision: 'approve' | 'discard'
  remembered?: { id: number; expiresAt: number | null; kind: string; target: string }
  /** 一批对象时：放行了几项、一共几项 */
  count?: { approved: number; of: number }
}
export type MemoryPayload = { rule: string; diff: string; total: number; removed?: boolean; by?: 'operator' }
export type RoutineMode = 'act' | 'watch'
export type RoutinePayload = {
  routineId: number
  name: string
  cron: string
  human: string
  webhook?: boolean
  mode?: RoutineMode
}
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
/** webhook 带来的东西，网关已排好版、截过长 */
export type WebhookPayload = { routineId: number; name: string; body: string }
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
  /** 同一个密钥，单独给 GitHub 当 Secret 用来签名 */
  webhook_secret?: string | null
  mode?: RoutineMode
}

export type Skill = { name: string; description: string }

/** 动作日志里的一笔：哪个工具、对什么、成没成、谁叫它开始的 */
export type ActionEntry = {
  id: number
  thread_id: string
  trigger: string
  tool: string
  summary: string
  ok: boolean | null
  ms: number | null
  created_at: number
}

export type ApprovalRule = {
  id: number
  kind: string
  target: string
  expiresAt: number | null
  createdAt: number
  /** false：去向校验收紧之前留下的模糊规则，还列着但不再放行任何东西 */
  applies?: boolean
  whyNot?: string
}

export type UsageTotals = { prompt: number; completion: number; cached: number; total: number }

export type ComputerInfo = {
  botId: string
  running: boolean
  /** 这台电脑是什么做的：容器（sealed）还是本机沙箱 */
  kind?: 'docker' | 'local'
  /** 网关给的 noVNC 页面地址，连接参数（含口令）都已带好 */
  vncUrl: string | null
  /** 屏幕怎么看：容器是 noVNC 页面，本机是浏览器截屏流 */
  screen?: { kind: 'vnc'; url: string } | { kind: 'cdp'; url: string } | null
  /** 本机模式：浏览器此刻以窗口开在桌面上（接管登录中） */
  window?: boolean
  error?: string
  routines: ComputerRoutine[]
  usage?: { today: UsageTotals; budget: number }
  /** 还在生效的「以后都放行」 */
  rules?: ApprovalRule[]
  /** MEMORY.md 里的规矩，一条一行 */
  memory?: string[]
  /** 所有同事共用的技能（做事手册） */
  skills?: Skill[]
  /** 最近做过的动作，最新的在前 */
  actions?: ActionEntry[]
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
  | 'webhook'

export type Message = {
  id: number
  thread_id: string
  sender: string // 'user' | bot id | 'webhook'
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
    | WebhookPayload
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
