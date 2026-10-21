import type { MessageRow } from './db.js'

/**
 * 侧栏上每位同事的状态：在干活 / 在等你（审批、问题、登录） / 卡住了（出错、超额、步数用完） / 闲着。
 * 「刚干完」是界面自己记的：在你没看着的时候从 thinking 落回来。
 */
export type Presence = 'thinking' | 'waiting' | 'blocked' | 'idle'

export type GatewayEvent =
  | { type: 'message'; threadId: string; message: MessageRow }
  | { type: 'status'; botId: string; state: Presence }
  | { type: 'hello'; statuses: Record<string, Presence> }

type WsLike = { send(data: string): void }

export type Hub = {
  add(ws: WsLike): void
  remove(ws: WsLike): void
  broadcast(event: GatewayEvent): void
  size(): number
}

export function createHub(): Hub {
  const clients = new Set<WsLike>()
  return {
    add: (ws) => clients.add(ws),
    remove: (ws) => clients.delete(ws),
    broadcast(event) {
      const data = JSON.stringify(event)
      for (const ws of clients) {
        try { ws.send(data) } catch { clients.delete(ws) }
      }
    },
    size: () => clients.size,
  }
}
