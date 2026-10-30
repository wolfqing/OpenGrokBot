import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, resolve, sep } from 'node:path'
import type { Hono } from 'hono'
import type { WSEvents } from 'hono/ws'

/**
 * 屏幕：查看页和 noVNC 库都由网关自己提供（npm 装的那份），只把 websockify 的数据流转发给容器。
 * 绝不代理容器里的网页文件——bot 在自己的容器里是 root，改一下那边的 HTML，
 * 它的脚本就会以你的身份跑在网关的源上（能放行审批、能摸别的 bot 的屏幕）。
 */
const NOVNC_ROOT = dirname(dirname(createRequire(import.meta.url).resolve('@novnc/novnc')))

export function screenPagePath(botId: string, password?: string): string {
  const page = `/vnc/${encodeURIComponent(botId)}/view.html`
  // 口令放在 # 后面：浏览器不会把片段发给任何服务器，也就不会出现在日志里
  return password ? `${page}#password=${encodeURIComponent(password)}` : page
}

const VIEWER = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Screen</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  #screen { width: 100%; height: 100%; }
  #status { position: fixed; left: 8px; bottom: 6px; font: 12px -apple-system, BlinkMacSystemFont, sans-serif; color: #8f8f8f; pointer-events: none; }
</style>
</head>
<body>
<div id="screen"></div>
<div id="status">Connecting…</div>
<script type="module">
  import RFB from './core/rfb.js'
  const screen = document.getElementById('screen')
  const status = document.getElementById('status')
  const password = new URLSearchParams(location.hash.slice(1)).get('password') ?? ''
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname.replace(/[^/]*$/, 'websockify')
  let retry = 0
  function connect() {
    screen.replaceChildren()
    const rfb = new RFB(screen, url, { credentials: { password } })
    rfb.scaleViewport = true
    rfb.addEventListener('connect', () => { retry = 0; status.textContent = '' })
    rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password }))
    rfb.addEventListener('securityfailure', () => { status.textContent = 'The screen refused the password — reopen the panel.' })
    rfb.addEventListener('disconnect', () => {
      status.textContent = 'Reconnecting…'
      setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000))
    })
  }
  connect()
</script>
</body>
</html>
`

/** 谁的屏幕正开着：有人在看（比如正在接管登录）就别把那台电脑当成闲置停掉 */
export type ScreenViewers = { open(botId: string): void; close(botId: string): void; watching(botId: string): boolean }

export function createScreenViewers(): ScreenViewers {
  const counts = new Map<string, number>()
  return {
    open: (botId) => { counts.set(botId, (counts.get(botId) ?? 0) + 1) },
    close: (botId) => {
      const left = (counts.get(botId) ?? 1) - 1
      if (left > 0) counts.set(botId, left)
      else counts.delete(botId)
    },
    watching: (botId) => (counts.get(botId) ?? 0) > 0,
  }
}

/** /vnc/:botId/view.html 与它要的 noVNC 模块；websockify 的升级请求留给 main.ts 里的 WS 路由。 */
export function mountScreenProxy(app: Hono, deps: { knownBot: (botId: string) => boolean }): void {
  app.get('/vnc/:botId/*', async (c, next) => {
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') return next()
    const botId = c.req.param('botId')
    if (!deps.knownBot(botId)) return c.json({ error: 'unknown bot' }, 404)
    const rest = c.req.path.slice(`/vnc/${botId}`.length)
    if (rest === '/view.html') {
      return c.body(VIEWER, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(rest)
    } catch {
      return c.json({ error: 'not found' }, 404)
    }
    const file = resolve(NOVNC_ROOT, `.${decoded}`)
    const allowed = /^\/(core|vendor)\//.test(decoded)
      && file.startsWith(NOVNC_ROOT + sep)
      && extname(file) === '.js'
      && existsSync(file) && statSync(file).isFile()
    if (!allowed) return c.json({ error: 'not found' }, 404)
    return c.body(await readFile(file), 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    })
  })
}

/**
 * 把浏览器里 noVNC 的连接接到容器的 websockify：两头的帧原样转（二进制是 noVNC 的画面和键鼠），
 * 上游还没连上时先排队；任一头断了另一头也关。hooks 让调用方记下「有人在看这块屏幕」。
 */
export function screenRelay(target: string, hooks: { onOpen?: () => void; onClose?: () => void } = {}): WSEvents {
  let upstream: WebSocket | null = null
  const queued: (string | ArrayBuffer)[] = []
  return {
    onOpen: (_evt, ws) => {
      hooks.onOpen?.()
      upstream = new WebSocket(target)
      upstream.binaryType = 'arraybuffer'
      upstream.onopen = () => { for (const data of queued.splice(0)) upstream?.send(data) }
      upstream.onmessage = (ev) => ws.send(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer))
      upstream.onclose = () => ws.close()
      upstream.onerror = () => ws.close()
    },
    onMessage: (evt) => {
      const data = evt.data as string | ArrayBuffer
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(data)
      else queued.push(data)
    },
    onClose: () => {
      hooks.onClose?.()
      upstream?.close()
    },
  }
}
