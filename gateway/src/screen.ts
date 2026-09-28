import type { Hono } from 'hono'
import type { Pool } from './pool.js'

/**
 * 屏幕走网关代理：面板里的 noVNC 和网关同源，吃同一个登录 cookie，
 * 经一条 SSH 隧道就能远程接管；容器的 6080 只给网关自己连。
 */
export function screenPagePath(botId: string, password?: string): string {
  const id = encodeURIComponent(botId)
  const params = new URLSearchParams({ autoconnect: '1', resize: 'scale', reconnect: '1', path: `vnc/${id}/websockify` })
  if (password) params.set('password', password)
  return `/vnc/${id}/vnc.html?${params.toString()}`
}

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

const PASSED_HEADERS = ['content-type', 'content-length', 'cache-control', 'last-modified', 'etag']

/** noVNC 的页面和静态资源：原样取自那台电脑的 websockify，只转发无害的响应头。 */
export function mountScreenProxy(
  app: Hono,
  deps: { pool: Pool; knownBot: (botId: string) => boolean; fetchImpl?: typeof fetch },
): void {
  const fetchImpl = deps.fetchImpl ?? fetch
  app.get('/vnc/:botId/*', async (c, next) => {
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') return next()
    const botId = c.req.param('botId')
    if (!deps.knownBot(botId)) return c.json({ error: 'unknown bot' }, 404)
    let base: string | undefined
    try {
      base = (await deps.pool.get(botId)).screen?.base
    } catch (err) {
      return c.text(`No screen right now: ${err instanceof Error ? err.message : String(err)}`, 503)
    }
    if (!base) return c.text('This teammate has no screen.', 503)
    const rest = c.req.path.slice(`/vnc/${botId}`.length) || '/'
    const upstream = await fetchImpl(`${base}${rest}${new URL(c.req.url).search}`)
    const headers = new Headers()
    for (const name of PASSED_HEADERS) {
      const value = upstream.headers.get(name)
      if (value) headers.set(name, value)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  })
}
