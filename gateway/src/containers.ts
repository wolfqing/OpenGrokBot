import { randomBytes } from 'node:crypto'
import type Docker from 'dockerode'

export const BOT_IMAGE = 'opengrokbot/bot:dev'
/** 所有 bot 电脑共用的网络：关掉容器之间的互访，谁也碰不到别人的 shim、CDP 和屏幕 */
export const BOT_NETWORK = 'opengrokbot-bots'
/** 容器规格变了（隔离、限额、密钥……）就升这个号：旧容器会在下次启动时按新规格重建，workspace 不动 */
export const SPEC_VERSION = '2'

const SHIM_PORT = '7717/tcp'
const CDP_PORT = '9222/tcp'
const VNC_PORT = '6080/tcp'

export type Endpoints = { shim: string; cdp: string; vnc: string; shimToken?: string; vncPassword?: string }
export type ContainerSecrets = { shimToken: string; vncPassword: string }
export type ContainerOptions = { memoryMb?: number; cpus?: number; timeZone?: string }

export function containerName(botId: string): string {
  return `opengrokbot-${botId}`
}

/** VNC 口令协议上只认前 8 个字符 */
function newSecrets(): ContainerSecrets {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(8)
  const vncPassword = [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
  return { shimToken: randomBytes(24).toString('base64url'), vncPassword }
}

export function createContainerSpec(
  botId: string,
  workspaceDir: string,
  secrets: ContainerSecrets,
  opts: ContainerOptions = {},
): Docker.ContainerCreateOptions {
  const loopback = [{ HostIp: '127.0.0.1', HostPort: '' }] // 空 HostPort = Docker 动态分配
  const memoryMb = opts.memoryMb ?? 2048
  const cpus = opts.cpus ?? 2
  return {
    name: containerName(botId),
    Image: BOT_IMAGE,
    Labels: { 'ai.opengrokbot.bot': botId, 'ai.opengrokbot.spec': SPEC_VERSION },
    Env: [
      `SHIM_TOKEN=${secrets.shimToken}`,
      `VNC_PASSWORD=${secrets.vncPassword}`,
      ...(opts.timeZone ? [`TZ=${opts.timeZone}`] : []),
    ],
    ExposedPorts: { [SHIM_PORT]: {}, [CDP_PORT]: {}, [VNC_PORT]: {} },
    HostConfig: {
      Binds: [`${workspaceDir}:/workspace`],
      PortBindings: { [SHIM_PORT]: loopback, [CDP_PORT]: loopback, [VNC_PORT]: loopback },
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: BOT_NETWORK,
      // 失控的命令（死循环、fork 炸弹、吃内存的页面）只能拖垮它自己，拖不垮宿主
      ...(memoryMb > 0 ? { Memory: Math.round(memoryMb * 1024 * 1024) } : {}),
      ...(cpus > 0 ? { NanoCpus: Math.round(cpus * 1e9) } : {}),
      PidsLimit: 512,
      SecurityOpt: ['no-new-privileges'],
      // Chromium 会派生一堆子进程：让 docker-init 当 PID 1 收僵尸
      Init: true,
    },
  }
}

export function readEndpoints(inspect: unknown): Endpoints {
  const info = inspect as {
    NetworkSettings?: { Ports?: Record<string, { HostPort?: string }[] | null> }
    Config?: { Env?: string[] }
  }
  const ports = info.NetworkSettings?.Ports ?? {}
  const pick = (key: string): string => {
    const hostPort = ports[key]?.[0]?.HostPort
    if (!hostPort) throw new Error(`container port ${key.split('/')[0]} not published`)
    return `http://127.0.0.1:${hostPort}`
  }
  const env = info.Config?.Env ?? []
  const fromEnv = (name: string) => env.find((e) => e.startsWith(`${name}=`))?.slice(name.length + 1)
  const shimToken = fromEnv('SHIM_TOKEN')
  const vncPassword = fromEnv('VNC_PASSWORD')
  return {
    shim: pick(SHIM_PORT),
    cdp: pick(CDP_PORT),
    vnc: pick(VNC_PORT),
    ...(shimToken ? { shimToken } : {}),
    ...(vncPassword ? { vncPassword } : {}),
  }
}

async function pollUntilOk(
  url: string,
  failureMessage: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) })
      if (res.ok) return
      lastError = `returned ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`${failureMessage}: ${lastError}`)
}

export function waitForShim(shimUrl: string, timeoutMs = 60_000, fetchImpl: typeof fetch = fetch): Promise<void> {
  return pollUntilOk(`${shimUrl}/health`, `bot container never became ready at ${shimUrl}`, timeoutMs, fetchImpl)
}

/** shim 比 Chromium 先就绪，所以新容器必须单独等 CDP，否则第一次用浏览器必然被拒连。 */
export function waitForCdp(cdpUrl: string, timeoutMs = 60_000, fetchImpl: typeof fetch = fetch): Promise<void> {
  return pollUntilOk(`${cdpUrl}/json/version`, `bot browser never became ready at ${cdpUrl}`, timeoutMs, fetchImpl)
}

type DockerLike = Pick<Docker, 'listNetworks' | 'createNetwork' | 'listContainers' | 'getContainer' | 'createContainer' | 'getImage'>

async function ensureNetwork(docker: DockerLike): Promise<void> {
  const existing = await docker.listNetworks({ filters: { name: [BOT_NETWORK] } })
  if (existing.some((n) => n.Name === BOT_NETWORK)) return
  try {
    await docker.createNetwork({
      Name: BOT_NETWORK,
      Driver: 'bridge',
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      Labels: { 'ai.opengrokbot': 'bots' },
    })
  } catch (err) {
    // 两个 bot 同时冷启动时，另一个可能刚建好
    if ((err as { statusCode?: number }).statusCode !== 409) throw err
  }
}

async function currentImageId(docker: DockerLike): Promise<string | null> {
  try {
    return (await docker.getImage(BOT_IMAGE).inspect()).Id
  } catch {
    return null
  }
}

export async function ensureContainer(
  docker: DockerLike,
  botId: string,
  workspaceDir: string,
  opts: ContainerOptions & { fetchImpl?: typeof fetch; readyTimeoutMs?: number } = {},
): Promise<Endpoints> {
  await ensureNetwork(docker)
  const name = containerName(botId)
  const existing = (await docker.listContainers({ all: true, filters: { name: [name] } }))
    .find((c) => c.Names.includes(`/${name}`))
  let container = existing ? docker.getContainer(existing.Id) : null
  if (container && existing) {
    const imageId = await currentImageId(docker)
    const outdatedSpec = existing.Labels?.['ai.opengrokbot.spec'] !== SPEC_VERSION
    const outdatedImage = imageId !== null && existing.ImageID !== imageId
    if (outdatedSpec || outdatedImage) {
      // 登录态和文件都在挂载的 workspace 里，重建容器不丢东西
      console.log(`[gateway] rebuilding ${name}: ${outdatedSpec ? 'new container spec' : 'bot image was rebuilt'}`)
      await container.remove({ force: true })
      container = null
    } else if (existing.State !== 'running') {
      await container.start()
    }
  }
  if (!container) {
    try {
      container = await docker.createContainer(createContainerSpec(botId, workspaceDir, newSecrets(), opts))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if ((err as { statusCode?: number }).statusCode === 404 || /no such image/i.test(message)) {
        throw new Error(`The bot computer image ${BOT_IMAGE} is not built yet. Run: docker build -t ${BOT_IMAGE} docker/bot`)
      }
      throw err
    }
    await container.start()
  }
  const endpoints = readEndpoints(await container.inspect())
  const fetchImpl = opts.fetchImpl ?? fetch
  await waitForShim(endpoints.shim, opts.readyTimeoutMs, fetchImpl)
  await waitForCdp(endpoints.cdp, opts.readyTimeoutMs, fetchImpl)
  return endpoints
}

/** 空闲回收用：停机不删容器，下次用时原样拉起（登录态在 workspace 里）。 */
export async function stopBotContainer(docker: Pick<Docker, 'getContainer'>, botId: string): Promise<void> {
  try {
    await docker.getContainer(containerName(botId)).stop({ t: 5 })
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode
    if (code !== 304 && code !== 404) throw err // 已经停了 / 不存在都算成功
  }
}

/** 正在跑的 bot 电脑（包括网关重启之前就开着的） */
export async function runningBotIds(docker: Pick<Docker, 'listContainers'>): Promise<string[]> {
  const list = await docker.listContainers({ filters: { label: ['ai.opengrokbot.bot'], status: ['running'] } })
  return list.map((c) => c.Labels?.['ai.opengrokbot.bot']).filter((id): id is string => Boolean(id))
}
