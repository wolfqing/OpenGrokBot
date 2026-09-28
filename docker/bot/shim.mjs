// 容器内迷你 HTTP shim：shell 执行 + 文件读写，外加给 Chromium 的 CDP 把门。零依赖，只用 node 原生模块。
// 宿主侧仅发布到 127.0.0.1；除 /health 外每个请求都要带网关建容器时生成的 SHIM_TOKEN。
// 为什么 CDP 也要口令：在 Docker Desktop 上，别的容器能经 host.docker.internal 摸到宿主上发布的端口，
// 没有口令的 CDP 就等于把这台电脑的浏览器（连同登录态）送给了别的 bot。
import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { dirname, resolve } from 'node:path'

const ROOT = '/workspace'
const PORT = Number(process.env.SHIM_PORT || 7717)
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const CDP_UPSTREAM = 9223 // Chromium 自己只听容器内回环的 9223
const TOKEN = process.env.SHIM_TOKEN || ''
const MAX_BODY = 16 * 1024 * 1024
const MAX_OUTPUT = 8 * 1024 * 1024
const DEFAULT_SHELL_MS = 60_000
const MAX_SHELL_MS = 10 * 60_000

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

/** 超时一律封顶：模型给 0 或一个天文数字，也不能让这台电脑的一条车道永远卡住 */
function shellTimeout(requested) {
  const ms = Number(requested)
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_SHELL_MS
  return Math.min(ms, MAX_SHELL_MS)
}

/**
 * 命令放进自己的进程组（spawn detached；exec() 会悄悄丢掉 detached 这个选项）：超时或被停掉时整组杀掉。
 * 只杀 bash 的话，`sleep`、`npm run dev` 这些孙进程会成为孤儿接着跑。
 * bash 退出后稍等片刻就收尾：后台进程（`server &`）占着输出管道时，调用不该一直挂着。
 */
function runShell(cmd, timeoutMs, signal) {
  return new Promise((resolveShell) => {
    const child = spawn('/bin/bash', ['-c', cmd], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const errOut = []
    let size = 0
    let timedOut = false
    let settled = false
    let grace
    const collect = (bucket) => (chunk) => {
      if (size >= MAX_OUTPUT) return
      size += chunk.length
      bucket.push(chunk)
    }
    child.stdout.on('data', collect(out))
    child.stderr.on('data', collect(errOut))
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已经结束了 */ }
    }
    const timer = setTimeout(() => { timedOut = true; killGroup() }, shellTimeout(timeoutMs))
    if (signal?.aborted) killGroup()
    else signal?.addEventListener('abort', killGroup, { once: true })
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      signal?.removeEventListener('abort', killGroup)
      // 后台进程之后写的输出照常排空，别让它们因为管道写满而卡住
      for (const stream of [child.stdout, child.stderr]) {
        stream.removeAllListeners('data')
        stream.resume()
      }
      const stderr = Buffer.concat(errOut).toString('utf8')
      resolveShell({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: stderr || (timedOut ? 'command timed out' : ''),
        exitCode: typeof code === 'number' ? code : 1,
      })
    }
    child.on('close', (code) => finish(code))
    child.on('exit', (code) => { grace = setTimeout(() => finish(code), 300) })
    child.on('error', (err) => {
      errOut.push(Buffer.from(String(err.message)))
      finish(127)
    })
  })
}

const routes = {
  // 网关那头停了（操作者按了停止、或请求超时）就连命令一起杀掉，别让它在后台接着跑
  'POST /shell': async (body, signal) => runShell(String(body.cmd ?? ''), body.timeoutMs, signal),
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
  const gone = new AbortController()
  res.on('close', () => { if (!res.writableFinished) gone.abort() })
  try {
    const result = await handler(await readBody(req), gone.signal)
    if (result && result.status) return send(result.status, result.body)
    send(200, result)
  } catch (err) {
    send(500, { error: err instanceof Error ? err.message : String(err) })
  }
}).listen(PORT, '0.0.0.0', () => console.log(`[shim] listening on ${PORT}`))

// ── CDP：验过口令才转给容器内的 Chromium ───────────────────────────
const cdp = createServer((req, res) => {
  if (!tokenMatches(req.headers['x-shim-token'])) {
    res.writeHead(401, { 'Content-Type': 'text/plain' })
    res.end('missing or wrong shim token')
    return
  }
  const headers = { ...req.headers, host: `127.0.0.1:${CDP_UPSTREAM}` }
  delete headers['x-shim-token']
  const upstream = httpRequest(
    { host: '127.0.0.1', port: CDP_UPSTREAM, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end(err.message)
  })
  req.pipe(upstream)
})

cdp.on('upgrade', (req, socket, head) => {
  if (!tokenMatches(req.headers['x-shim-token'])) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    return
  }
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]
    const lower = name.toLowerCase()
    if (lower === 'x-shim-token') continue
    lines.push(`${name}: ${lower === 'host' ? `127.0.0.1:${CDP_UPSTREAM}` : req.rawHeaders[i + 1]}`)
  }
  const upstream = connect(CDP_UPSTREAM, '127.0.0.1', () => {
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  const drop = () => { upstream.destroy(); socket.destroy() }
  upstream.on('error', drop)
  socket.on('error', drop)
  upstream.on('close', () => socket.destroy())
  socket.on('close', () => upstream.destroy())
})

cdp.listen(CDP_PORT, '0.0.0.0', () => console.log(`[shim] guarding CDP on ${CDP_PORT}`))
