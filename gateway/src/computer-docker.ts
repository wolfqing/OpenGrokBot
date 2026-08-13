import { chromium } from 'playwright-core'
import type { BotComputer, ShellResult, Shot } from './computer.js'
import type { Endpoints } from './containers.js'

type PageLike = {
  goto(url: string, opts?: unknown): Promise<unknown>
  title(): Promise<string>
  url(): string
  innerText(selector: string): Promise<string>
  screenshot(opts?: unknown): Promise<Buffer>
  click(selector: string, opts?: unknown): Promise<void>
  getByText?(text: string): { first(): { click(opts?: unknown): Promise<void> } }
  viewportSize(): { width: number; height: number } | null
}

type BrowserLike = {
  contexts(): { pages(): PageLike[]; newPage(): Promise<PageLike> }[]
  close(): Promise<void>
}

export type DockerComputerDeps = {
  fetchImpl?: typeof fetch
  connect?: (cdpUrl: string) => Promise<BrowserLike>
}

/**
 * 容器里的 Chromium 在 /json/version 里报的是它自己的地址（ws://0.0.0.0:9222/…），
 * 而 playwright 的 connectOverCDP 会原样使用该地址、不改写 host。宿主要连的是 Docker
 * 动态映射出来的端口，所以这里自己把 host:port 换掉，再交给 playwright。
 */
export async function resolveCdpWsUrl(cdpUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const base = cdpUrl.replace(/\/$/, '')
  const res = await fetchImpl(`${base}/json/version`)
  if (!res.ok) throw new Error(`CDP /json/version returned ${res.status} at ${base}`)
  const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string }
  if (!webSocketDebuggerUrl) throw new Error(`CDP endpoint ${base} reported no webSocketDebuggerUrl`)
  const ws = new URL(webSocketDebuggerUrl)
  const mapped = new URL(base)
  ws.hostname = mapped.hostname
  ws.port = mapped.port
  return ws.toString()
}

export function createDockerComputer(endpoints: Endpoints, deps: DockerComputerDeps = {}): BotComputer {
  const fetchImpl = deps.fetchImpl ?? fetch
  const connect = deps.connect ?? (async (url: string) =>
    chromium.connectOverCDP(await resolveCdpWsUrl(url, fetchImpl)) as unknown as BrowserLike)

  let browser: BrowserLike | null = null
  let pending: Promise<BrowserLike> | null = null

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${endpoints.shim}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(String(data.error ?? `shim ${path} failed with ${res.status}`))
    return data as T
  }

  async function page(): Promise<PageLike> {
    if (!browser) {
      pending ??= connect(endpoints.cdp)
      browser = await pending
    }
    const context = browser.contexts()[0]
    if (!context) throw new Error('bot browser has no context')
    return context.pages()[0] ?? (await context.newPage())
  }

  return {
    vncUrl: endpoints.vnc,
    async shell(cmd, timeoutMs) {
      return post<ShellResult>('/shell', { cmd, timeoutMs })
    },
    async readFile(path) {
      return (await post<{ content: string }>('/read', { path })).content
    },
    async writeFile(path, content) {
      await post('/write', { path, content })
    },
    async goto(url) {
      const p = await page()
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      return { url: p.url(), title: await p.title() }
    },
    async extract(maxChars) {
      const text = (await (await page()).innerText('body')).replace(/\n{3,}/g, '\n\n').trim()
      return maxChars ? text.slice(0, maxChars) : text
    },
    async click(target) {
      const p = await page()
      try {
        await p.click(target, { timeout: 5_000 })
      } catch (selectorError) {
        // 不是合法 selector 就按可见文字点——bot 更常说"点 Sign in"而不是 CSS
        if (!p.getByText) throw selectorError
        await p.getByText(target).first().click({ timeout: 5_000 })
      }
      return { clicked: target }
    },
    async screenshot(): Promise<Shot> {
      const p = await page()
      const buffer = await p.screenshot({ type: 'png' })
      const size = p.viewportSize() ?? { width: 1280, height: 800 }
      return { buffer, width: size.width, height: size.height }
    },
    async dispose() {
      const b = browser
      browser = null
      pending = null
      await b?.close().catch(() => {}) // CDP 断开失败不该拖垮调用方
    },
  }
}
