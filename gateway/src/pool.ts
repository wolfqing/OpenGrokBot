import { mkdir } from 'node:fs/promises'
import type Docker from 'dockerode'
import type { BotComputer } from './computer.js'
import { createDockerComputer } from './computer-docker.js'
import { ensureContainer } from './containers.js'
import { workspaceDir } from './screenshots.js'

export type Pool = {
  get(botId: string): Promise<BotComputer>
  disposeAll(): Promise<void>
}

export function createPool(opts: {
  dataDir: string
  docker?: Docker
  makeComputer?: (botId: string) => Promise<BotComputer>
}): Pool {
  const live = new Map<string, Promise<BotComputer>>()

  const makeComputer = opts.makeComputer ?? (async (botId: string) => {
    if (!opts.docker) throw new Error('no docker client configured; bot computers are unavailable')
    const dir = workspaceDir(opts.dataDir, botId)
    await mkdir(dir, { recursive: true })
    return createDockerComputer(await ensureContainer(opts.docker, botId, dir))
  })

  return {
    get(botId) {
      const existing = live.get(botId)
      if (existing) return existing
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
  }
}
