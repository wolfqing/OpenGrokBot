import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Handler, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

export const SESSION_COOKIE = 'ogb_session'

/**
 * 网关令牌放在数据目录里、只给本人读。它不在任何 bot 的 workspace 里，
 * 所以容器里的 bot（哪怕被网页注入了指令）拿不到它，也就放行不了自己的审批。
 */
export function loadOrCreateToken(dataDir: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim()
  const path = join(dataDir, 'auth-token')
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) return existing
  }
  mkdirSync(dataDir, { recursive: true })
  const token = randomBytes(24).toString('base64url')
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
  chmodSync(path, 0o600) // umask 不该把它放宽
  return token
}

function sameToken(presented: string, token: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 页面本身（静态文件）和登录入口是公开的；数据、实时流、屏幕都要令牌。 */
export function isProtectedPath(path: string): boolean {
  return path.startsWith('/api/') || path === '/ws' || path.startsWith('/vnc/')
}

function presentedToken(c: Context): string | undefined {
  const header = c.req.header('authorization')
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim()
  return getCookie(c, SESSION_COOKIE)
}

function originAllowed(c: Context, allowedOrigins: string[]): boolean {
  const origin = c.req.header('origin')
  if (!origin) return true // curl、脚本不带 Origin，交给令牌把关
  if (allowedOrigins.includes(origin)) return true
  try {
    return new URL(origin).host === new URL(c.req.url).host
  } catch {
    return false
  }
}

/**
 * 同一台机器上别的端口也算「同站」，SameSite=Strict 的 cookie 照样会带过去——
 * 所以改状态的请求和 WS 握手还要求 Origin 就是网关自己。
 */
export function authMiddleware(token: string, allowedOrigins: string[] = []): MiddlewareHandler {
  return async (c, next) => {
    if (!isProtectedPath(c.req.path)) return next()
    const presented = presentedToken(c)
    if (!presented || !sameToken(presented, token)) return c.json({ error: 'sign in first' }, 401)
    const upgrading = c.req.header('upgrade')?.toLowerCase() === 'websocket'
    const changesState = upgrading || !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
    if (changesState && !originAllowed(c, allowedOrigins)) {
      return c.json({ error: 'cross-origin request refused' }, 403)
    }
    return next()
  }
}

/** 启动日志里的一次性链接：/auth?token=… → 种下 HttpOnly + SameSite=Strict 的会话 cookie。 */
export function loginHandler(token: string): Handler {
  return (c) => {
    if (!sameToken(c.req.query('token') ?? '', token)) {
      return c.text('That sign-in link does not match this gateway. Use the one printed at startup.', 401)
    }
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      secure: new URL(c.req.url).protocol === 'https:',
    })
    return c.redirect('/', 302)
  }
}
