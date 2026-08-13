import type { MessageRow } from './db.js'

export type GatewayEvent =
  | { type: 'message'; threadId: string; message: MessageRow }
  | { type: 'status'; botId: string; state: 'thinking' | 'idle' }

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
