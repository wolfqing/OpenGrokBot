import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type Docker from 'dockerode'
import { browsersDir, findBrowser, installBrowser } from './browsers.js'
import type { BotComputer, ComputerKind } from './computer.js'
import { createDockerComputer } from './computer-docker.js'
import { createLocalComputer, type LocalLaunch } from './computer-local.js'
import { ensureContainer, runningBotIds, stopBotContainer, type ContainerOptions } from './containers.js'
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

/** OPENGROKBOT_COMPUTERS：auto = 有 Docker 用 Docker，没有就用本机模式 */
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
      await mkdir(workspace, { recursive: true })
      await mkdir(profileDir, { recursive: true })
      const computer = createLocalComputer({ workspaceDir: workspace, profileDir, executablePath, launch: opts.launch })
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
      return [...live.keys()]
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

export type BackendChoice = { backend: ComputerBackend; reason: string }

/**
 * 选后端。显式指定就听指定的；auto 先看 Docker 在不在。
 * `local` 回 null 表示这个构建里还没有本机模式（M6 做到 B 片之前）。
 */
export async function chooseBackend(choice: ComputerChoice, opts: {
  docker: () => ComputerBackend
  local: () => ComputerBackend | null
  dockerReachable: () => Promise<boolean>
}): Promise<BackendChoice> {
  if (choice === 'docker') return { backend: opts.docker(), reason: 'OPENGROKBOT_COMPUTERS=docker' }
  if (choice === 'local') {
    const local = opts.local()
    if (!local) throw new Error('OPENGROKBOT_COMPUTERS=local, but this gateway has no local computer backend yet')
    return { backend: local, reason: 'OPENGROKBOT_COMPUTERS=local' }
  }
  if (await opts.dockerReachable()) return { backend: opts.docker(), reason: 'Docker is running' }
  const local = opts.local()
  if (local) return { backend: local, reason: 'Docker is not running' }
  return {
    backend: opts.docker(),
    reason: 'Docker is not running and this gateway has no local mode yet — computers will fail until Docker starts',
  }
}
