export type ReportLine = { system: string; result: string; count?: string }
export type ReportPayload = { lines: ReportLine[]; closing?: string }

export type Message = {
  id: number
  thread_id: string
  sender: string // 'user' | bot id
  kind: 'text' | 'report'
  content: string
  payload: ReportPayload | null
  created_at: number
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
