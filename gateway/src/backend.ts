import { mkdir } from 'node:fs/promises'
import type Docker from 'dockerode'
import type { BotComputer, ComputerKind } from './computer.js'
import { createDockerComputer } from './computer-docker.js'
import { ensureContainer, runningBotIds, stopBotContainer, type ContainerOptions } from './containers.js'
import { workspaceDir } from './screenshots.js'

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
