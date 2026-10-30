import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { chromium } from 'playwright-core'
import { createBrowserSession, pageOperations, type BrowserLike, type ContextLike } from './browser-page.js'
import type { BotComputer, ShellResult } from './computer.js'

/**
 * 本机模式的电脑：浏览器是宿主上直接拉起来的 Chromium（一位同事一个配置目录，登录态留在里面），
 * 文件只许碰 workspace；命令行默认没有（M6 C 片按同事打开，开了走系统沙箱）。
 * 和容器不同，这里没有守护进程：网关退出浏览器就一起关，下次用时原样再起。
 */

/** 容器里的 shim 也是 16 MB：两种电脑对「文件太大」的判断一致 */
const MAX_FILE_BYTES = 16 * 1024 * 1024
/** bot 的提示词和工具说明里都叫 /workspace；本机模式把它映射到这位同事的文件夹 */
const VIRTUAL_ROOT = '/workspace'

export type LocalLaunch = (opts: { profileDir: string; executablePath: string; headless: boolean }) => Promise<BrowserLike>

export type LocalShell = {
  /** 操作者此刻开着这位同事的命令行吗（每次调用都问，面板上一关立刻生效） */
  enabled: () => boolean
  run: (cmd: string, timeoutMs?: number, signal?: AbortSignal) => Promise<ShellResult>
}

export type LocalComputerOptions = {
  workspaceDir: string
  profileDir: string
  executablePath: string
  headless?: boolean
  launch?: LocalLaunch
  /** 不传 = 这台电脑没有命令行 */
  shell?: LocalShell
}

/**
 * 把 bot 给的路径落到 workspace 里：相对路径按 workspace 解析，/workspace/... 换成真实目录，
 * 其它绝对路径一律不认。只看字符串；符号链接逃逸由 confined() 再查一遍。
 */
export function workspacePath(workspaceDir: string, given: string): string | null {
  const root = resolve(workspaceDir)
  let p = given.trim()
  if (p === VIRTUAL_ROOT || p.startsWith(`${VIRTUAL_ROOT}/`)) p = p.slice(VIRTUAL_ROOT.length).replace(/^\/+/, '') || '.'
  else if (isAbsolute(p)) return null
  const full = resolve(root, p)
  const rel = relative(root, full)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return full
}

/** 字符串上没逃逸还不够：路径里的符号链接可能指到外面。按最深的已存在祖先的真实位置再查一次。 */
async function confined(workspaceDir: string, given: string): Promise<string> {
  const full = workspacePath(workspaceDir, given)
  if (!full) throw new Error('path escapes workspace')
  const root = await realpath(workspaceDir)
  let probe = full
  for (;;) {
    try {
      const real = await realpath(probe)
      const rest = relative(probe, full)
      const landed = rest ? join(real, rest) : real
      if (landed !== root && !landed.startsWith(root + sep)) throw new Error('path escapes workspace')
      return landed
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = dirname(probe)
      if (parent === probe) throw new Error('path escapes workspace')
      probe = parent
    }
  }
}

const defaultLaunch: LocalLaunch = async ({ profileDir, executablePath, headless }) => {
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless,
    viewport: { width: 1280, height: 800 },
    // 上次没正常退出时 Chrome 会弹「恢复页面？」挡住屏幕
    args: ['--hide-crash-restore-bubble'],
  })
  let open = true
  context.on('close', () => { open = false })
  return {
    contexts: () => [context as unknown as ContextLike],
    close: () => context.close(),
    isConnected: () => open,
  }
}

export function createLocalComputer(opts: LocalComputerOptions): BotComputer {
  const launch = opts.launch ?? defaultLaunch
  let headless = opts.headless ?? true
  const session = createBrowserSession(() => launch({ profileDir: opts.profileDir, executablePath: opts.executablePath, headless }))

  /**
   * Chromium 不能在运行中切换有没有窗口：关掉再以另一种方式开同一个配置。
   * 登录态在配置目录里，两边共享；当前页面也带过去，操作者看到的就是 bot 卡住的那一页。
   */
  async function relaunch(nextHeadless: boolean): Promise<void> {
    let url: string | undefined
    if (session.state() === 'open') url = await session.page().then((p) => p.url()).catch(() => undefined)
    await session.dispose()
    headless = nextHeadless
    const p = await session.page()
    if (url && url !== 'about:blank') await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
  }

  return {
    kind: 'local',
    async ping() {
      // 还没开过浏览器也算活着：它随时能开；开过又没了才说明这台电脑坏了，让 pool 换一台
      return session.state() !== 'gone'
    },
    async screencast(onFrame) {
      const context = await session.context()
      if (!context.newCDPSession) throw new Error('this browser cannot stream its screen')
      const page = await session.page()
      const cdp = await context.newCDPSession(page)
      type Frame = { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }
      let stopped = false
      cdp.on('Page.screencastFrame', (frame: Frame) => {
        if (stopped) return
        onFrame({ data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight })
        // 不确认上一帧，Chromium 就不发下一帧——借这一点把帧率压在 10 帧/秒上下，面板和网关都轻松
        setTimeout(() => { void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {}) }, 100)
      })
      // 无头浏览器只在画面变化时出帧；静止的页面要先给面板一张现状，别让人对着黑屏等
      const size = page.viewportSize() ?? { width: 1280, height: 800 }
      const first = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null)
      if (first) onFrame({ data: first.toString('base64'), width: size.width, height: size.height })
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 })
      return async () => {
        stopped = true
        await cdp.send('Page.stopScreencast').catch(() => {})
        await cdp.detach().catch(() => {})
      }
    },
    async showWindow() {
      if (!headless && session.state() === 'open') return
      await relaunch(false)
    },
    async hideWindow() {
      if (headless) return // 本来就在后台；不为了「隐藏」去开一个
      await relaunch(true)
    },
    windowShown: () => !headless,
    async shell(cmd, timeoutMs, signal) {
      if (!opts.shell?.enabled()) {
        throw new Error('Commands are off on this computer. Your operator can turn them on in the computer panel.')
      }
      return opts.shell.run(cmd, timeoutMs, signal)
    },
    async readFile(path) {
      const full = await confined(opts.workspaceDir, path)
      const info = await stat(full)
      if (!info.isFile()) throw new Error('not a file')
      if (info.size > MAX_FILE_BYTES) throw new Error('file too large')
      return readFile(full, 'utf8')
    },
    async writeFile(path, content) {
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('content too large')
      const full = await confined(opts.workspaceDir, path)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, content, 'utf8')
    },
    ...pageOperations(() => session.page()),
    dispose: () => session.dispose(),
  }
}
