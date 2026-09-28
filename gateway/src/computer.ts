export type ShellResult = { stdout: string; stderr: string; exitCode: number }
export type Shot = { buffer: Buffer; width: number; height: number }
export type PageLink = { text: string; href: string }

/** 一台 bot 自己的电脑：shell、文件、浏览器。实现见 computer-docker.ts。 */
export interface BotComputer {
  /** 这台电脑的屏幕地址（noVNC 页面，已带好连接参数）；没有容器就没有屏幕。 */
  readonly vncUrl?: string
  /** 这台电脑还应答吗？容器一重启端口就全变了，缓存的连接会全废。 */
  ping(): Promise<boolean>
  shell(cmd: string, timeoutMs?: number): Promise<ShellResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  goto(url: string): Promise<{ url: string; title: string }>
  /** 当前页可见文字（全文，分页由调用方做） */
  extract(maxChars?: number): Promise<string>
  /** 当前页上的链接：innerText 会把 href 丢掉，bot 需要知道能去哪 */
  links(): Promise<PageLink[]>
  click(target: string): Promise<{ clicked: string; url?: string; title?: string }>
  type(target: string, text: string, submit?: boolean): Promise<void>
  press(key: string): Promise<void>
  scroll(direction: 'up' | 'down'): Promise<void>
  back(): Promise<{ url: string; title: string }>
  screenshot(): Promise<Shot>
  dispose(): Promise<void>
}

// 1x1 PNG，够测试断言"有字节"即可
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export function createFakeComputer(
  overrides: Partial<BotComputer> & { pageText?: string; pageLinks?: PageLink[] } = {},
): BotComputer & { calls: string[] } {
  const calls: string[] = []
  const pageText = overrides.pageText ?? 'Example Domain — this domain is for use in examples.'
  const pageLinks = overrides.pageLinks ?? []
  const base: BotComputer = {
    async ping() { return true },
    async shell(cmd) { calls.push(`shell:${cmd}`); return { stdout: 'hi\n', stderr: '', exitCode: 0 } },
    async readFile(path) { calls.push(`read:${path}`); return 'file contents' },
    async writeFile(path) { calls.push(`write:${path}`) },
    async goto(url) { calls.push(`goto:${url}`); return { url, title: 'Example Domain' } },
    async extract(maxChars) { calls.push('extract'); return maxChars ? pageText.slice(0, maxChars) : pageText },
    async links() { return pageLinks },
    async click(target) { calls.push(`click:${target}`); return { clicked: target } },
    async type(target) { calls.push(`type:${target}`) },
    async press(key) { calls.push(`press:${key}`) },
    async scroll(direction) { calls.push(`scroll:${direction}`) },
    async back() { calls.push('back'); return { url: 'https://example.com/', title: 'Example Domain' } },
    async screenshot() { calls.push('screenshot'); return { buffer: TINY_PNG, width: 1280, height: 800 } },
    async dispose() { calls.push('dispose') },
  }
  type MutableComputer = { -readonly [K in keyof BotComputer]: BotComputer[K] }
  const wrapped: MutableComputer = { ...base, ...(overrides.vncUrl ? { vncUrl: overrides.vncUrl } : {}) }
  for (const key of Object.keys(base) as (keyof BotComputer)[]) {
    const override = overrides[key]
    if (typeof override === 'function') {
      wrapped[key] = (async (...args: unknown[]) => {
        calls.push(`${key}:${String(args[0] ?? '')}`.replace(/:$/, ''))
        return (override as (...a: unknown[]) => unknown)(...args)
      }) as never
    }
  }
  return Object.assign(wrapped, { calls })
}
