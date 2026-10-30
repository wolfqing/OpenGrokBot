import type { BotComputer, PageLink, Shot } from './computer.js'

/**
 * 浏览器那一半的电脑：页面操作只认 playwright 的 Page，不关心它是容器里经 CDP 连来的，
 * 还是本机直接拉起来的。两种后端（computer-docker、computer-local）都拼这一套。
 */

type Fillable = { first(): { fill(text: string, opts?: unknown): Promise<void> } }

export type PageLike = {
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

export type ContextLike = { pages(): PageLike[]; newPage(): Promise<PageLike> }

export type BrowserLike = {
  contexts(): ContextLike[]
  close(): Promise<void>
  /** Chromium 重启或崩溃后旧连接就废了；playwright 的 Browser 有这个方法。 */
  isConnected?(): boolean
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

function missing(what: string): never {
  throw new Error(`the bot browser has no ${what} control`)
}

/**
 * 一个浏览器连接的缓存：失败不留在缓存里（否则一次冷启动抖动会让这台电脑的浏览器永久报废），
 * 浏览器没了就下次重开。`open` 由后端给：容器是 connectOverCDP，本机是 launch。
 */
export type BrowserSession = {
  page(): Promise<PageLike>
  /** idle = 还没开过；open = 连着；gone = 开过但浏览器没了（下次 page() 会重开）。不会去开新的。 */
  state(): 'idle' | 'open' | 'gone'
  dispose(): Promise<void>
}

export function createBrowserSession(open: () => Promise<BrowserLike>): BrowserSession {
  let browser: BrowserLike | null = null
  let pending: Promise<BrowserLike> | null = null
  let everOpened = false

  function dropIfGone(): void {
    if (browser?.isConnected && !browser.isConnected()) {
      browser = null
      pending = null
    }
  }

  return {
    async page() {
      dropIfGone()
      if (!browser) {
        pending ??= open().catch((err: unknown) => {
          pending = null
          throw err
        })
        browser = await pending
        everOpened = true
      }
      const context = browser.contexts()[0]
      if (!context) throw new Error('bot browser has no context')
      // 点开新标签页之后，用户（和 bot）要接着看的就是最新的那个
      const pages = context.pages()
      return pages[pages.length - 1] ?? (await context.newPage())
    },
    state() {
      dropIfGone()
      return browser ? 'open' : everOpened ? 'gone' : 'idle'
    },
    async dispose() {
      const b = browser
      browser = null
      pending = null
      everOpened = false
      await b?.close().catch(() => {}) // 断开失败不该拖垮调用方
    },
  }
}

export type PageOperations = Pick<
  BotComputer, 'goto' | 'extract' | 'links' | 'click' | 'type' | 'press' | 'scroll' | 'back' | 'screenshot'
>

/** BotComputer 里和浏览器有关的那些方法，全部建立在「给我当前页面」之上。 */
export function pageOperations(page: () => Promise<PageLike>): PageOperations {
  return {
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
      return Array.isArray(found) ? (found as PageLink[]) : []
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
  }
}
