import { chromium } from 'playwright-core'
import type { BotComputer, ShellResult, Shot } from './computer.js'
import type { Endpoints } from './containers.js'

type Fillable = { first(): { fill(text: string, opts?: unknown): Promise<void> } }

type PageLike = {
  goto(url: string, opts?: unknown): Promise<unknown>
  title(): Promise<string>
  url(): string
  innerText(selector: string): Promise<string>
  screenshot(opts?: unknown): Promise<Buffer>
  click(selector: string, opts?: unknown): Promise<void>
  getByText?(text: string): { first(): { click(opts?: unknown): Promise<void> } }
  fill?(selector: string, text: string, opts?: unknown): Promise<void>
  getByLabel?(text: string): Fillable
  getByPlaceholder?(text: string): Fillable
  keyboard?: { press(key: string): Promise<void> }
  mouse?: { wheel(dx: number, dy: number): Promise<void> }
  goBack?(opts?: unknown): Promise<unknown>
  waitForLoadState?(state?: string, opts?: unknown): Promise<void>
  evaluate?(script: string): Promise<unknown>
  viewportSize(): { width: number; height: number } | null
}

/** 在页面里跑：收集可见链接（去重、跳过 javascript:），给 bot 一张「能去哪」的清单。 */
const LINKS_SCRIPT = `(() => {
  const seen = new Set(); const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!href || href.startsWith('javascript:') || seen.has(href)) continue;
    const box = a.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    seen.add(href); out.push({ text, href });
    if (out.length >= 60) break;
  }
  return out;
})()`

/** 像 CSS selector 的先按 selector 找；像一句话的先按文字/标签找，免得白等 selector 超时。 */
function looksLikeSelector(target: string): boolean {
  return /[#.[\]=:>]/.test(target) || /^[a-z][a-z0-9-]*$/.test(target)
}

async function firstThatWorks(attempts: (() => Promise<void>)[]): Promise<void> {
  let firstError: unknown
  for (const attempt of attempts) {
    try {
      await attempt()
      return
    } catch (err) {
      firstError ??= err
    }
  }
  throw firstError
}

type BrowserLike = {
  contexts(): { pages(): PageLike[]; newPage(): Promise<PageLike> }[]
  close(): Promise<void>
  /** Chromium 重启或崩溃后旧连接就废了；playwright 的 Browser 有这个方法。 */
  isConnected?(): boolean
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

function missing(what: string): never {
  throw new Error(`the bot browser has no ${what} control`)
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
      headers: {
        'Content-Type': 'application/json',
        // 容器专属的口令：本机别的网页或进程摸到这个端口也调不动 shell
        ...(endpoints.shimToken ? { 'x-shim-token': endpoints.shimToken } : {}),
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(String(data.error ?? `shim ${path} failed with ${res.status}`))
    return data as T
  }

  async function page(): Promise<PageLike> {
    if (browser?.isConnected && !browser.isConnected()) {
      browser = null
      pending = null
    }
    if (!browser) {
      // 连接失败不能留在缓存里，否则一次冷启动抖动会让这台电脑的浏览器永久报废
      pending ??= connect(endpoints.cdp).catch((err: unknown) => {
        pending = null
        throw err
      })
      browser = await pending
    }
    const context = browser.contexts()[0]
    if (!context) throw new Error('bot browser has no context')
    // 点开新标签页之后，用户（和 bot）要接着看的就是最新的那个
    const pages = context.pages()
    return pages[pages.length - 1] ?? (await context.newPage())
  }

  const answers = async (url: string) => {
    try {
      return (await fetchImpl(url, { signal: AbortSignal.timeout(5_000) })).ok
    } catch {
      return false
    }
  }

  return {
    screen: { base: endpoints.vnc, ...(endpoints.vncPassword ? { password: endpoints.vncPassword } : {}) },
    async ping() {
      // shim 活着但浏览器挂了，也算这台电脑不可用：换一个新连接（容器里的守护进程会把 Chromium 拉回来）
      return (await answers(`${endpoints.shim}/health`)) && (await answers(`${endpoints.cdp}/json/version`))
    },
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
    async links() {
      const p = await page()
      if (!p.evaluate) return []
      const found = await p.evaluate(LINKS_SCRIPT)
      return Array.isArray(found) ? (found as { text: string; href: string }[]) : []
    },
    async click(target) {
      const p = await page()
      // bot 更常说「点 Sign in」而不是 CSS：两种都试，顺序按目标长得像什么来定
      const bySelector = () => p.click(target, { timeout: 5_000 })
      const byText = async () => {
        if (!p.getByText) throw new Error(`no element matches ${target}`)
        await p.getByText(target).first().click({ timeout: 5_000 })
      }
      await firstThatWorks(looksLikeSelector(target) ? [bySelector, byText] : [byText, bySelector])
      await p.waitForLoadState?.('domcontentloaded', { timeout: 5_000 }).catch(() => {})
      const now = await page()
      return { clicked: target, url: now.url(), title: await now.title() }
    },
    async type(target, text, submit) {
      const p = await page()
      const bySelector = async () => {
        if (!p.fill) throw new Error('this browser cannot fill fields')
        await p.fill(target, text, { timeout: 3_000 })
      }
      const byLabel = async () => {
        if (!p.getByLabel) throw new Error(`no field labelled ${target}`)
        await p.getByLabel(target).first().fill(text, { timeout: 3_000 })
      }
      const byPlaceholder = async () => {
        if (!p.getByPlaceholder) throw new Error(`no field with placeholder ${target}`)
        await p.getByPlaceholder(target).first().fill(text, { timeout: 3_000 })
      }
      await firstThatWorks(looksLikeSelector(target)
        ? [bySelector, byLabel, byPlaceholder]
        : [byLabel, byPlaceholder, bySelector])
      if (submit) await (p.keyboard ?? missing('keyboard')).press('Enter')
    },
    async press(key) {
      await ((await page()).keyboard ?? missing('keyboard')).press(key)
    },
    async scroll(direction) {
      await ((await page()).mouse ?? missing('mouse')).wheel(0, direction === 'down' ? 700 : -700)
    },
    async back() {
      const p = await page()
      if (!p.goBack) missing('history')
      await p.goBack!({ waitUntil: 'domcontentloaded', timeout: 45_000 })
      return { url: p.url(), title: await p.title() }
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
