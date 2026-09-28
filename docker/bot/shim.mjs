// 容器内迷你 HTTP shim：shell 执行 + 文件读写。零依赖，只用 node 原生模块。
// 宿主侧仅发布到 127.0.0.1；除 /health 外每个请求都要带网关建容器时生成的 SHIM_TOKEN。
import { exec } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'

const ROOT = '/workspace'
const PORT = Number(process.env.SHIM_PORT || 7717)
const TOKEN = process.env.SHIM_TOKEN || ''
const MAX_BODY = 16 * 1024 * 1024

function tokenMatches(presented) {
  if (!TOKEN) return true // 老网关建的容器没有口令：照旧放行，网关升级后会重建容器
  const a = Buffer.from(String(presented ?? ''))
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

function safePath(p) {
  const full = resolve(ROOT, p ?? '')
  if (full !== ROOT && !full.startsWith(ROOT + '/')) return null
  return full
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function runShell(cmd, timeoutMs) {
  return new Promise((resolveShell) => {
    exec(cmd, { cwd: ROOT, timeout: timeoutMs ?? 60000, maxBuffer: 8 * 1024 * 1024, shell: '/bin/bash' },
      (err, stdout, stderr) => {
        resolveShell({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? (err && err.killed ? 'command timed out' : '')),
          exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        })
      })
  })
}

const routes = {
  'POST /shell': async (body) => runShell(String(body.cmd ?? ''), body.timeoutMs),
  'POST /read': async (body) => {
    const full = safePath(body.path)
    if (!full) return { status: 400, body: { error: 'path escapes workspace' } }
    try { return { content: await readFile(full, 'utf8') } }
    catch { return { status: 404, body: { error: `no such file: ${body.path}` } } }
  },
  'POST /write': async (body) => {
    const full = safePath(body.path)
    if (!full) return { status: 400, body: { error: 'path escapes workspace' } }
    const content = String(body.content ?? '')
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
    return { ok: true, bytes: Buffer.byteLength(content) }
  },
}

createServer(async (req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`
  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  if (key === 'GET /health') return send(200, { ok: true })
  if (!tokenMatches(req.headers['x-shim-token'])) return send(401, { error: 'missing or wrong shim token' })
  const handler = routes[key]
  if (!handler) return send(404, { error: `no route ${key}` })
  try {
    const result = await handler(await readBody(req))
    if (result && result.status) return send(result.status, result.body)
    send(200, result)
  } catch (err) {
    send(500, { error: err instanceof Error ? err.message : String(err) })
  }
}).listen(PORT, '0.0.0.0', () => console.log(`[shim] listening on ${PORT}`))
