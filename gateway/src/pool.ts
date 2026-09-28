import { mkdir } from 'node:fs/promises'
import type Docker from 'dockerode'
import type { BotComputer } from './computer.js'
import { createDockerComputer } from './computer-docker.js'
import { ensureContainer, type ContainerOptions } from './containers.js'
import { workspaceDir } from './screenshots.js'

export type Pool = {
  get(botId: string): Promise<BotComputer>
  disposeAll(): Promise<void>
  /** 上次有人（bot 的工具、面板、预热）要这台电脑的时间；没用过是 undefined */
  lastUsed(botId: string): number | undefined
  /** 断开并忘掉缓存的连接（停机前用） */
  forget(botId: string): Promise<void>
  /** 停机：期间有人要这台电脑，就等停完再按需重新拉起，而不是递给它一台马上要停的 */
  retire(botId: string, stop: () => Promise<void>): Promise<void>
}

export function createPool(opts: {
  dataDir: string
  docker?: Docker
  makeComputer?: (botId: string) => Promise<BotComputer>
  containerOptions?: ContainerOptions
  now?: () => number
}): Pool {
  const live = new Map<string, Promise<BotComputer>>()
  const used = new Map<string, number>()
  const retiring = new Map<string, Promise<void>>()
  const now = opts.now ?? Date.now

  const makeComputer = opts.makeComputer ?? (async (botId: string) => {
    if (!opts.docker) throw new Error('no docker client configured; bot computers are unavailable')
    const dir = workspaceDir(opts.dataDir, botId)
    await mkdir(dir, { recursive: true })
    return createDockerComputer(await ensureContainer(opts.docker, botId, dir, opts.containerOptions))
  })

  /** 容器重启后端口会重新映射，缓存的连接就全指向旧端口——先探一下活。 */
  async function reuseIfAlive(botId: string, pending: Promise<BotComputer>): Promise<BotComputer | null> {
    try {
      const computer = await pending
      if (await computer.ping()) return computer
      await computer.dispose().catch(() => {})
    } catch {
      // 上一次启动就失败了，当没有缓存处理
    }
    live.delete(botId)
    return null
  }

  return {
    async get(botId) {
      await retiring.get(botId)?.catch(() => {})
      used.set(botId, now())
      const existing = live.get(botId)
      if (existing) {
        const alive = await reuseIfAlive(botId, existing)
        if (alive) return alive
      }
      // 失败不留缓存，否则一次 docker 抖动会永久毒化这个 bot
      const started = makeComputer(botId).catch((err) => {
        live.delete(botId)
        throw err
      })
      live.set(botId, started)
      return started
    },
    async disposeAll() {
      const all = [...live.values()]
      live.clear()
      await Promise.all(all.map((p) => p.then((c) => c.dispose()).catch(() => {})))
    },
    lastUsed: (botId) => used.get(botId),
    forget,
    async retire(botId, stop) {
      const job = (async () => {
        await forget(botId)
        await stop()
      })()
      retiring.set(botId, job)
      try {
        await job
      } finally {
        retiring.delete(botId)
      }
    },
  }

  async function forget(botId: string): Promise<void> {
    const pending = live.get(botId)
    live.delete(botId)
    used.delete(botId)
    await pending?.then((c) => c.dispose()).catch(() => {})
  }
}

/**
 * 空闲回收：每台开着的 bot 电脑（包括网关重启前就开着的）闲置超过 idleMs、且主人没在干活，就停机。
 * 下次有人要它时 pool.get 会原样拉起；登录态和文件都在 workspace 里，不会丢。
 */
export async function reapIdleComputers(opts: {
  pool: Pool
  idleMs: number
  runningBots: () => Promise<string[]>
  isBusy: (botId: string) => boolean
  stop: (botId: string) => Promise<void>
  now: number
  /** 网关启动时间：启动后还没被用过的电脑从这一刻开始算闲置 */
  startedAt: number
}): Promise<string[]> {
  const reaped: string[] = []
  for (const botId of await opts.runningBots()) {
    if (opts.isBusy(botId)) continue
    const last = opts.pool.lastUsed(botId) ?? opts.startedAt
    if (opts.now - last < opts.idleMs) continue
    await opts.pool.retire(botId, () => opts.stop(botId))
    reaped.push(botId)
  }
  return reaped
}
