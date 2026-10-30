import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve, upgradeWebSocket, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { screenRelay } from '../src/screen.js'

/** 假的 websockify：二进制帧倒过来发回，文本帧转大写发回，这样能分清是谁回的 */
function fakeWebsockify(): Promise<{ url: string; close: () => void; connections: () => number }> {
  return new Promise((resolve) => {
    let connections = 0
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = wss.address() as AddressInfo
      resolve({ url: `ws://127.0.0.1:${port}/websockify`, close: () => wss.close(), connections: () => connections })
    })
    wss.on('connection', (ws) => {
      connections++
      ws.on('message', (data, isBinary) => {
        if (isBinary) ws.send(Buffer.from(data as Buffer).reverse())
        else ws.send(String(data).toUpperCase())
      })
    })
  })
}

/** 用真实的 node-server 和它自带的 WebSocket 支持跑网关里那条屏幕转发 */
function gatewayWithRelay(target: string, hooks: Parameters<typeof screenRelay>[1]): Promise<{ url: string; server: ServerType }> {
  const app = new Hono()
  app.get('/vnc/bot/websockify', upgradeWebSocket(() => screenRelay(target, hooks)))
  return new Promise((resolve) => {
    const server = serve({
      fetch: app.fetch, port: 0, hostname: '127.0.0.1', websocket: { server: new WebSocketServer({ noServer: true }) },
    }, (info) => resolve({ url: `ws://127.0.0.1:${info.port}/vnc/bot/websockify`, server }))
  })
}

const opened = (ws: WebSocket) => new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject })
const nextMessage = (ws: WebSocket) => new Promise<MessageEvent>((resolve) => { ws.onmessage = resolve })

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

describe('screen relay over node-server WebSockets', () => {
  it('carries binary frames both ways byte for byte, large ones included', async () => {
    const upstream = await fakeWebsockify()
    const gateway = await gatewayWithRelay(upstream.url, {})
    cleanups.push(upstream.close, () => gateway.server.close())
    const ws = new WebSocket(gateway.url)
    ws.binaryType = 'arraybuffer'
    cleanups.push(() => ws.close())
    await opened(ws)

    for (const size of [1, 1500, 300_000]) {
      const frame = randomBytes(size)
      const reply = nextMessage(ws)
      ws.send(frame)
      const back = Buffer.from((await reply).data as ArrayBuffer)
      expect(back.length).toBe(size)
      expect(back.equals(Buffer.from(frame).reverse())).toBe(true)
    }
  })

  it('carries text frames as text', async () => {
    const upstream = await fakeWebsockify()
    const gateway = await gatewayWithRelay(upstream.url, {})
    cleanups.push(upstream.close, () => gateway.server.close())
    const ws = new WebSocket(gateway.url)
    cleanups.push(() => ws.close())
    await opened(ws)
    const reply = nextMessage(ws)
    ws.send('rfb 003.008')
    expect((await reply).data).toBe('RFB 003.008')
  })

  it('tells the gateway when someone starts and stops watching, and closes upstream with the viewer', async () => {
    const upstream = await fakeWebsockify()
    const onOpen = vi.fn()
    const onClose = vi.fn()
    const gateway = await gatewayWithRelay(upstream.url, { onOpen, onClose })
    cleanups.push(upstream.close, () => gateway.server.close())
    const ws = new WebSocket(gateway.url)
    await opened(ws)
    await vi.waitFor(() => expect(upstream.connections()).toBe(1))
    expect(onOpen).toHaveBeenCalledTimes(1)
    ws.close()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('closes the viewer when the computer side cannot be reached', async () => {
    const onClose = vi.fn()
    const gateway = await gatewayWithRelay('ws://127.0.0.1:9/websockify', { onClose }) // 9 号端口没人听
    cleanups.push(() => gateway.server.close())
    const ws = new WebSocket(gateway.url)
    const closed = new Promise<void>((resolve) => { ws.onclose = () => resolve() })
    await closed
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
