export type ShellResult = { stdout: string; stderr: string; exitCode: number }
export type Shot = { buffer: Buffer; width: number; height: number }
export type PageLink = { text: string; href: string }

/** 哪种电脑：容器里的（sealed），还是本机沙箱里的（local） */
export type ComputerKind = 'docker' | 'local'

/** 浏览器画面的一帧（JPEG，base64）：本机模式的屏幕就是这个流 */
export type ScreencastFrame = { data: string; width: number; height: number }

/** 一台 bot 自己的电脑：shell、文件、浏览器。实现见 computer-docker.ts / computer-local.ts。 */
export interface BotComputer {
  readonly kind: ComputerKind
  /** 容器电脑的屏幕：noVNC 的地址（只给网关代理用）和 VNC 口令。 */
  readonly screen?: { base: string; password?: string }
  /** 本机电脑的屏幕：订阅浏览器画面，返回取消订阅。 */
  screencast?(onFrame: (frame: ScreencastFrame) => void): Promise<() => Promise<void>>
  /** 接管登录（本机模式）：把浏览器以普通窗口开到桌面上；hideWindow 切回后台。两者都保住当前页面和登录态。 */
  showWindow?(): Promise<void>
  hideWindow?(): Promise<void>
  windowShown?(): boolean
  /** 这台电脑还应答吗？容器一重启端口就全变了，缓存的连接会全废。 */
  ping(): Promise<boolean>
  /** signal：操作者按了停止，立刻放弃这次调用（容器里的 shim 会把命令一起杀掉） */
  shell(cmd: string, timeoutMs?: number, signal?: AbortSignal): Promise<ShellResult>
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
    kind: overrides.kind ?? 'docker',
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
  const wrapped: MutableComputer = {
    ...base,
    ...(overrides.screen ? { screen: overrides.screen } : {}),
    // 本机模式才有的可选能力：给了就原样带上（不记 calls）
    ...(overrides.screencast ? { screencast: overrides.screencast } : {}),
    ...(overrides.showWindow ? { showWindow: overrides.showWindow } : {}),
    ...(overrides.hideWindow ? { hideWindow: overrides.hideWindow } : {}),
    ...(overrides.windowShown ? { windowShown: overrides.windowShown } : {}),
  }
  for (const key of Object.keys(base) as (keyof BotComputer)[]) {
    if (key === 'kind') continue
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
