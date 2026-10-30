import { chromium } from 'playwright-core'
import { createBrowserSession, pageOperations, type BrowserLike } from './browser-page.js'
import type { BotComputer, ShellResult } from './computer.js'
import type { Endpoints } from './containers.js'

export type DockerComputerDeps = {
  fetchImpl?: typeof fetch
  connect?: (cdpUrl: string, headers?: Record<string, string>) => Promise<BrowserLike>
}

/**
 * 容器里的 Chromium 在 /json/version 里报的是它自己的地址（ws://0.0.0.0:9222/…），
 * 而 playwright 的 connectOverCDP 会原样使用该地址、不改写 host。宿主要连的是 Docker
 * 动态映射出来的端口，所以这里自己把 host:port 换掉，再交给 playwright。
 */
export async function resolveCdpWsUrl(
  cdpUrl: string,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = {},
): Promise<string> {
  const base = cdpUrl.replace(/\/$/, '')
  const res = await fetchImpl(`${base}/json/version`, { headers })
  if (!res.ok) throw new Error(`CDP /json/version returned ${res.status} at ${base}`)
  const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string }
  if (!webSocketDebuggerUrl) throw new Error(`CDP endpoint ${base} reported no webSocketDebuggerUrl`)
  const ws = new URL(webSocketDebuggerUrl)
  const mapped = new URL(base)
  ws.hostname = mapped.hostname
  ws.port = mapped.port
  return ws.toString()
}

/** 容器里的电脑：shell 和文件走容器里的 shim，浏览器经 CDP 连容器里的 Chromium，屏幕是容器里的 noVNC。 */
export function createDockerComputer(endpoints: Endpoints, deps: DockerComputerDeps = {}): BotComputer {
  const fetchImpl = deps.fetchImpl ?? fetch
  // CDP 和 shim 用同一个容器口令把门：别的 bot 经宿主摸到这个端口也拿不到浏览器
  const tokenHeaders: Record<string, string> = endpoints.shimToken ? { 'x-shim-token': endpoints.shimToken } : {}
  const connect = deps.connect ?? (async (url: string, headers?: Record<string, string>) =>
    chromium.connectOverCDP(await resolveCdpWsUrl(url, fetchImpl, headers), { headers }) as unknown as BrowserLike)

  const session = createBrowserSession(() => connect(endpoints.cdp, endpoints.shimToken ? tokenHeaders : undefined))

  /** shim 调用一律有兜底超时；停止信号来了立刻放手 */
  async function post<T>(path: string, body: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000)
    const res = await fetchImpl(`${endpoints.shim}${path}`, {
      method: 'POST',
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      headers: {
        'Content-Type': 'application/json',
        // 容器专属的口令：本机别的网页或进程摸到这个端口也调不动 shell
        ...tokenHeaders,
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(String(data.error ?? `shim ${path} failed with ${res.status}`))
    return data as T
  }

  const answers = async (url: string) => {
    try {
      return (await fetchImpl(url, { headers: tokenHeaders, signal: AbortSignal.timeout(5_000) })).ok
    } catch {
      return false
    }
  }

  return {
    kind: 'docker',
    screen: { base: endpoints.vnc, ...(endpoints.vncPassword ? { password: endpoints.vncPassword } : {}) },
    async ping() {
      // shim 活着但浏览器挂了，也算这台电脑不可用：换一个新连接（容器里的守护进程会把 Chromium 拉回来）
      return (await answers(`${endpoints.shim}/health`)) && (await answers(`${endpoints.cdp}/json/version`))
    },
    async shell(cmd, timeoutMs, signal) {
      // 多给 15 秒：命令自己的超时由 shim 执行并返回结果，这里只兜 shim 本身失联的底
      return post<ShellResult>('/shell', { cmd, timeoutMs }, { signal, timeoutMs: (timeoutMs ?? 60_000) + 15_000 })
    },
    async readFile(path) {
      return (await post<{ content: string }>('/read', { path })).content
    },
    async writeFile(path, content) {
      await post('/write', { path, content })
    },
    ...pageOperations(() => session.page()),
    dispose: () => session.dispose(),
  }
}
