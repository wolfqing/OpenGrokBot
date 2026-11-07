import { execFileSync } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Handler, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

export const SESSION_COOKIE = 'osb_session'
/** 改名前种下的会话 cookie，有效期一年：照认，升级后不用每个浏览器重新登录 */
const LEGACY_SESSION_COOKIE = 'ogb_session'

/**
 * 网关令牌放在数据目录里、只给本人读。它不在任何 bot 的 workspace 里，
 * 所以容器里的 bot（哪怕被网页注入了指令）拿不到它，也就放行不了自己的审批。
 */
export function loadOrCreateToken(
  dataDir: string,
  explicit?: string,
  opts: { restrict?: (path: string) => void; warn?: (line: string) => void } = {},
): string {
  if (explicit?.trim()) return explicit.trim()
  const path = join(dataDir, 'auth-token')
  const restrict = opts.restrict ?? restrictToOwner
  const guard = () => {
    try {
      restrict(path)
    } catch (err) {
      // 收不紧也照常启动，但要让人知道：这个文件就是进网关的钥匙
      ;(opts.warn ?? console.warn)(`[gateway] could not limit ${path} to your account: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) {
      guard() // 老版本在 Windows 上建的令牌文件是继承来的权限，启动时顺手收紧
      return existing
    }
  }
  mkdirSync(dataDir, { recursive: true })
  const token = randomBytes(24).toString('base64url')
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
  guard()
  return token
}

type RunFile = (file: string, args: string[], opts: { encoding: 'utf8'; windowsHide: boolean }) => string

/**
 * 只给本人读写。POSIX 上是 0600（umask 不该把它放宽）。Windows 上 chmod 只管「只读」标记，权限在 ACL 里：
 * 先 /reset 把文件上直接写着的条目清掉（上级目录不往下传权限时，新文件会带上创建者的默认权限：SYSTEM、
 * Administrators……都是直接条目，/inheritance:r 摘不掉），再去掉继承来的条目，只给当前用户。
 * 用户按 SID 指定（whoami 给的），本地账户、域账户、微软账户都一样。
 */
export function restrictToOwner(
  path: string,
  platform: string = process.platform,
  run: RunFile = (file, args, o) => execFileSync(file, args, o),
): void {
  if (platform !== 'win32') {
    chmodSync(path, 0o600)
    return
  }
  // whoami /user /fo csv /nh → "pc\\ana","S-1-5-21-…"
  const sid = run('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).trim().match(/"(S-1-[\d-]+)"\s*$/)?.[1]
  if (!sid) throw new Error('whoami did not report a SID')
  run('icacls', [path, '/reset'], { encoding: 'utf8', windowsHide: true })
  run('icacls', [path, '/inheritance:r', '/grant:r', `*${sid}:F`], { encoding: 'utf8', windowsHide: true })
}

function sameToken(presented: string, token: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 页面本身（静态文件）和登录入口是公开的；数据、实时流、两种屏幕都要令牌。 */
export function isProtectedPath(path: string): boolean {
  return path.startsWith('/api/') || path === '/ws' || path.startsWith('/vnc/') || path.startsWith('/screen/')
}

function presentedToken(c: Context): string | undefined {
  const header = c.req.header('authorization')
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim()
  return getCookie(c, SESSION_COOKIE) ?? getCookie(c, LEGACY_SESSION_COOKIE)
}

/** 同一端口上的 localhost / 127.0.0.1 / [::1] 是同一台机器的同一个服务 */
function sameHost(a: URL, b: URL): boolean {
  const loopback = (h: string) => (['127.0.0.1', '[::1]', '::1'].includes(h) ? 'localhost' : h)
  return loopback(a.hostname) === loopback(b.hostname) && a.port === b.port
}

/** 网关自己的地址以 Host 头为准，不看请求 URL：以前的 @hono/node-ws 拼升级 URL 时会丢端口，Host 头才是浏览器真正连的地址 */
function selfUrl(c: Context): URL {
  const host = c.req.header('host')
  return host ? new URL(`http://${host}`) : new URL(c.req.url)
}

function originAllowed(c: Context, allowedOrigins: string[]): boolean {
  const origin = c.req.header('origin')
  if (!origin) return true // curl、脚本不带 Origin，交给令牌把关
  try {
    const from = new URL(origin)
    return sameHost(from, selfUrl(c)) || allowedOrigins.some((allowed) => sameHost(from, new URL(allowed)))
  } catch {
    return false
  }
}

/**
 * 界面所在的地址天然可信：dev 下是 Vite（5173），它的代理会把 Host 改成网关自己，
 * 光比 Host 会把正常请求当成跨站。再加上用户显式放行的来源（反代等）。
 */
export function trustedOrigins(opts: { webUrl: string; allowedOrigins: string[] }): string[] {
  const origins = [...opts.allowedOrigins]
  if (opts.webUrl) {
    try {
      origins.push(new URL(opts.webUrl).origin)
    } catch {
      // 配错了就当没配
    }
  }
  return origins
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
    // 带请求体的改动只收 JSON：别的页面（哪怕同站别的端口）发 JSON 必须先过预检，而网关从不应答预检
    const sendsBody = ['POST', 'PUT', 'PATCH'].includes(c.req.method)
    if (sendsBody && !(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'send application/json' }, 415)
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
