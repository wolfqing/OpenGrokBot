import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type Docker from 'dockerode'

export const BOT_IMAGE = 'opengrokbot/bot:dev'
/** 所有 bot 电脑共用的网络：关掉容器之间的互访，谁也碰不到别人的 shim、CDP 和屏幕 */
export const BOT_NETWORK = 'opengrokbot-bots'
/** 容器规格变了（隔离、限额、密钥……）就升这个号：旧容器会在下次启动时按新规格重建，workspace 不动 */
export const SPEC_VERSION = '3'

const SHIM_PORT = '7717/tcp'
const CDP_PORT = '9222/tcp'
const VNC_PORT = '6080/tcp'

export type Endpoints = { shim: string; cdp: string; vnc: string; shimToken?: string; vncPassword?: string }
export type ContainerSecrets = { shimToken: string; vncPassword: string }
export type ContainerOptions = { memoryMb?: number; cpus?: number; timeZone?: string }

const DEFAULT_MEMORY_MB = 2048
const DEFAULT_CPUS = 2

/** 塑造容器的设置（内存、CPU、时区）的指纹：改了设置，旧容器就得按新设置重建，否则改了等于没改 */
export function containerConfigKey(opts: ContainerOptions): string {
  const shape = { memoryMb: opts.memoryMb ?? DEFAULT_MEMORY_MB, cpus: opts.cpus ?? DEFAULT_CPUS, timeZone: opts.timeZone ?? '' }
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16)
}

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
  const memoryMb = opts.memoryMb ?? DEFAULT_MEMORY_MB
  const cpus = opts.cpus ?? DEFAULT_CPUS
  return {
    name: containerName(botId),
    Image: BOT_IMAGE,
    // 归属记在标签上：Docker Desktop 的列表接口把挂载路径报成虚拟机里的 /host_mnt/…，靠它比对会误判
    Labels: {
      'ai.opengrokbot.bot': botId,
      'ai.opengrokbot.spec': SPEC_VERSION,
      'ai.opengrokbot.workspace': resolve(workspaceDir),
      'ai.opengrokbot.config': containerConfigKey(opts),
    },
    Env: [
      `SHIM_TOKEN=${secrets.shimToken}`,
      `VNC_PASSWORD=${secrets.vncPassword}`,
      ...(opts.timeZone ? [`TZ=${opts.timeZone}`] : []),
    ],
    ExposedPorts: { [SHIM_PORT]: {}, [CDP_PORT]: {}, [VNC_PORT]: {} },
    HostConfig: {
      Binds: [`${resolve(workspaceDir)}:/workspace`], // 相对路径会被 docker 当成卷名
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
  headers: Record<string, string> = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5_000) })
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
export function waitForCdp(
  cdpUrl: string,
  timeoutMs = 60_000,
  fetchImpl: typeof fetch = fetch,
  token?: string,
): Promise<void> {
  return pollUntilOk(`${cdpUrl}/json/version`, `bot browser never became ready at ${cdpUrl}`, timeoutMs, fetchImpl,
    token ? { 'x-shim-token': token } : {})
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

function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

async function currentImageId(docker: DockerLike): Promise<string | null> {
  try {
    return (await docker.getImage(BOT_IMAGE).inspect()).Id
  } catch {
    return null
  }
}

/** 连不上 docker 的 socket：多半是 Docker Desktop 没开，直接说人话 */
function explainDockerDown(err: unknown): never {
  const code = (err as { code?: string }).code
  const message = err instanceof Error ? err.message : String(err)
  if (code === 'ECONNREFUSED' || code === 'ENOENT' || /docker\.sock/.test(message)) {
    throw new Error('Docker is not running. Start Docker Desktop (or the docker service), then open this again.')
  }
  throw err
}

export async function ensureContainer(
  docker: DockerLike,
  botId: string,
  workspaceDir: string,
  opts: ContainerOptions & { fetchImpl?: typeof fetch; readyTimeoutMs?: number } = {},
): Promise<Endpoints> {
  await ensureNetwork(docker).catch(explainDockerDown)
  const name = containerName(botId)
  const existing = (await docker.listContainers({ all: true, filters: { name: [name] } }))
    .find((c) => c.Names.includes(`/${name}`))
  let container = existing ? docker.getContainer(existing.Id) : null
  if (container && existing) {
    const imageId = await currentImageId(docker)
    const outdatedSpec = existing.Labels?.['ai.opengrokbot.spec'] !== SPEC_VERSION
    const outdatedImage = imageId !== null && existing.ImageID !== imageId
    // 同名容器可能是另一个数据目录的网关建的：挂错 workspace 就等于换了一台电脑
    const owner = existing.Labels?.['ai.opengrokbot.workspace']
    const otherWorkspace = owner !== undefined && !samePath(owner, workspaceDir)
    const otherSettings = existing.Labels?.['ai.opengrokbot.config'] !== containerConfigKey(opts)
    if (outdatedSpec || outdatedImage || otherWorkspace || otherSettings) {
      // 登录态和文件都在挂载的 workspace 里，重建容器不丢东西
      const why = outdatedSpec ? 'new container spec'
        : outdatedImage ? 'bot image was rebuilt'
          : otherWorkspace ? 'it belonged to another data dir' : 'memory, CPU or timezone settings changed'
      console.log(`[gateway] rebuilding ${name}: ${why}`)
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
  await waitForCdp(endpoints.cdp, opts.readyTimeoutMs, fetchImpl, endpoints.shimToken)
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

/** 这个网关名下正在跑的 bot 电脑（包括网关重启之前就开着的）；别的数据目录建的容器不归它管 */
export async function runningBotIds(docker: Pick<Docker, 'listContainers'>, dataDir: string): Promise<string[]> {
  const list = await docker.listContainers({ filters: { label: ['ai.opengrokbot.bot'], status: ['running'] } })
  return list.flatMap((c) => {
    const botId = c.Labels?.['ai.opengrokbot.bot']
    const owner = c.Labels?.['ai.opengrokbot.workspace']
    if (!botId || !owner) return []
    return samePath(owner, resolve(dataDir, 'workspaces', botId)) ? [botId] : []
  })
}
