import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type Docker from 'dockerode'
import { browsersDir, findBrowser, installBrowser } from './browsers.js'
import type { BotComputer, ComputerKind } from './computer.js'
import { createDockerComputer } from './computer-docker.js'
import { createLocalComputer, type LocalLaunch } from './computer-local.js'
import { BOT_IMAGE, ensureContainer, runningBotIds, stopBotContainer, type ContainerOptions } from './containers.js'
import { runSandboxed, type Sandbox } from './sandbox.js'
import { botDataDir, workspaceDir } from './screenshots.js'

/**
 * 电脑后端：决定一台 bot 电脑是什么做的。pool 只管缓存和探活，网关其它地方只认 BotComputer；
 * 这里是唯一知道「容器」「本机进程」区别的地方。
 */
export type ComputerBackend = {
  readonly kind: ComputerKind
  /** 拉起（或接上已有的）这位同事的电脑 */
  make(botId: string): Promise<BotComputer>
  /** 这个网关名下此刻开着的电脑（含网关重启前就开着的），空闲回收用 */
  running(): Promise<string[]>
  /** 停机不销毁：登录态和文件都留着，下次 make 原样拉起 */
  stop(botId: string): Promise<void>
}

/** OPENGROKBOT_COMPUTERS 或设置页：auto = Docker 在跑、镜像也建了就用 Docker，否则本机模式 */
export type ComputerChoice = 'auto' | 'docker' | 'local'

export function parseComputerChoice(value: string | undefined): ComputerChoice {
  const v = (value ?? '').trim().toLowerCase()
  return v === 'docker' || v === 'local' ? v : 'auto'
}

export function createDockerBackend(
  docker: Docker,
  opts: { dataDir: string; containerOptions?: ContainerOptions },
): ComputerBackend {
  return {
    kind: 'docker',
    async make(botId) {
      const dir = workspaceDir(opts.dataDir, botId)
      await mkdir(dir, { recursive: true })
      return createDockerComputer(await ensureContainer(docker, botId, dir, opts.containerOptions))
    },
    running: () => runningBotIds(docker, opts.dataDir),
    stop: (botId) => stopBotContainer(docker, botId),
  }
}

export type LocalBackendOptions = {
  dataDir: string
  /** OPENGROKBOT_BROWSER：操作者指定的浏览器可执行文件 */
  browser?: string
  /** OPENGROKBOT_BROWSER_MIRROR：下载浏览器时用的镜像主机 */
  browserMirror?: string
  log?: (line: string) => void
  /** 测试里换掉真正的浏览器启动 */
  launch?: LocalLaunch
  /** 测试里换掉找/下载浏览器 */
  resolveBrowser?: () => Promise<string>
  /** 命令行：按同事问「开了吗」，开了就在系统沙箱里跑。没有沙箱 = 没有命令行。 */
  shell?: { enabled: (botId: string) => boolean; sandbox: Sandbox | null }
}

/**
 * 本机后端：电脑就是宿主上的一个浏览器进程 + 一个文件夹。第一次要电脑时才去找浏览器
 * （找不到就下载），之后所有同事共用同一个可执行文件、各用各的配置目录。
 */
export function createLocalBackend(opts: LocalBackendOptions): ComputerBackend {
  const log = opts.log ?? (() => {})
  const live = new Map<string, BotComputer>()
  let executable: Promise<string> | null = null

  const resolveBrowser = opts.resolveBrowser ?? (async () => {
    const found = findBrowser({ dataDir: opts.dataDir, env: { OPENGROKBOT_BROWSER: opts.browser } })
    if (found) {
      log(`local teammates use the ${found.source} browser at ${found.executablePath}`)
      return found.executablePath
    }
    log('no Chromium-based browser on this machine')
    return installBrowser(browsersDir(opts.dataDir), { mirror: opts.browserMirror, log })
  })

  return {
    kind: 'local',
    async make(botId) {
      // 下载失败不留在缓存里，下次再试
      executable ??= resolveBrowser().catch((err: unknown) => {
        executable = null
        throw err
      })
      const executablePath = await executable
      const workspace = workspaceDir(opts.dataDir, botId)
      // 浏览器配置放网关自己的目录，不在 workspace 里：bot 读写文件时碰不到自己的 cookie 库
      const profileDir = join(botDataDir(opts.dataDir, botId), 'browser')
      const tmp = join(botDataDir(opts.dataDir, botId), 'tmp')
      await mkdir(workspace, { recursive: true })
      await mkdir(profileDir, { recursive: true })
      await mkdir(tmp, { recursive: true })
      const sandbox = opts.shell?.sandbox ?? null
      const shell = opts.shell && sandbox ? {
        enabled: () => opts.shell!.enabled(botId),
        run: (cmd: string, timeoutMs?: number, signal?: AbortSignal) =>
          runSandboxed(cmd, { sandbox, confinement: { workspace, tmp, dataDir: opts.dataDir }, timeoutMs, signal }),
      } : undefined
      const computer = createLocalComputer({ workspaceDir: workspace, profileDir, executablePath, launch: opts.launch, shell })
      const tracked: BotComputer = {
        ...computer,
        async dispose() {
          live.delete(botId)
          await computer.dispose()
        },
      }
      live.set(botId, tracked)
      return tracked
    },
    async running() {
      // 操作者手动退出了 Chrome 的那台不算在跑；下次要它时 pool 会原样再起
      const alive: string[] = []
      for (const [botId, computer] of live) if (await computer.ping()) alive.push(botId)
      return alive
    },
    async stop(botId) {
      await live.get(botId)?.dispose()
    },
  }
}

/** Docker 在不在：daemon 应答就算在（镜像建没建是另一回事，用到时再报） */
export async function dockerReachable(docker: Pick<Docker, 'ping'>, timeoutMs = 3_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      docker.ping(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('docker ping timed out')), timeoutMs) }),
    ])
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 为什么是这种电脑：界面按 code 翻译，reason 是给日志看的英文 */
export type BackendWhy = 'chosen' | 'docker_running' | 'docker_not_running' | 'docker_image_missing' | 'no_local_mode'
export type BackendChoice = { backend: ComputerBackend; why: BackendWhy; reason: string }

const BUILD_HINT = `docker build -t ${BOT_IMAGE} docker/bot`

/**
 * 选后端。显式指定（环境变量或设置页）就听指定的；auto 先看 Docker 在不在，在的话再看同事电脑的镜像建没建——
 * 没建就退到本机模式，而不是等到第一次要电脑时才失败。
 * `local` 回 null 表示这个构建里没有本机模式。
 */
export async function chooseBackend(choice: ComputerChoice, opts: {
  docker: () => ComputerBackend
  local: () => ComputerBackend | null
  dockerReachable: () => Promise<boolean>
  /** 不传 = 当作建好了 */
  dockerImageReady?: () => Promise<boolean>
  /** 显式选择从哪来，只影响日志措辞 */
  from?: 'env' | 'saved'
}): Promise<BackendChoice> {
  const chosen = opts.from === 'saved' ? `computers=${choice} in settings` : `OPENGROKBOT_COMPUTERS=${choice}`
  if (choice === 'docker') return { backend: opts.docker(), why: 'chosen', reason: chosen }
  if (choice === 'local') {
    const local = opts.local()
    if (!local) throw new Error(`${chosen}, but this gateway has no local computer backend yet`)
    return { backend: local, why: 'chosen', reason: chosen }
  }
  if (!(await opts.dockerReachable())) {
    const local = opts.local()
    if (local) return { backend: local, why: 'docker_not_running', reason: 'Docker is not running' }
    return {
      backend: opts.docker(), why: 'no_local_mode',
      reason: 'Docker is not running and this gateway has no local mode yet — computers will fail until Docker starts',
    }
  }
  if (opts.dockerImageReady && !(await opts.dockerImageReady())) {
    const local = opts.local()
    const missing = `Docker is running but the bot image ${BOT_IMAGE} is not built`
    if (local) return { backend: local, why: 'docker_image_missing', reason: `${missing} — using local computers (to use Docker: ${BUILD_HINT}, then restart)` }
    return { backend: opts.docker(), why: 'docker_image_missing', reason: `${missing} — computers will fail until you run: ${BUILD_HINT}` }
  }
  return { backend: opts.docker(), why: 'docker_running', reason: 'Docker is running' }
}
