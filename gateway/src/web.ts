import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { Hono } from 'hono'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** 这些前缀归网关自己：没匹配上就该是 404，而不是回落成前端页面 */
const RESERVED = ['/api/', '/ws', '/auth', '/vnc/']

/**
 * 构建好的前端由网关直接托管：一个端口、一个进程，适合常驻（launchd/systemd）和隧道访问。
 * 带哈希的 assets 永久缓存；index.html 每次都校验，发版后刷新就是新界面。
 */
export function serveWeb(app: Hono, distDir: string): boolean {
  const root = resolve(distDir)
  const index = join(root, 'index.html')
  if (!existsSync(index)) return false

  app.get('*', async (c, next) => {
    const path = c.req.path
    if (RESERVED.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))) return next()
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch {
      decoded = '/'
    }
    const target = resolve(root, `.${decoded}`)
    const inside = target === root || target.startsWith(root + sep)
    const isFile = inside && existsSync(target) && statSync(target).isFile()
    const file = isFile ? target : index
    const body = await readFile(file)
    const immutable = isFile && target.startsWith(join(root, 'assets') + sep)
    return c.body(body, 200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
  })
  return true
}
