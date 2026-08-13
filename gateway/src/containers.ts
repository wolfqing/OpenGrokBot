import type Docker from 'dockerode'

export const BOT_IMAGE = 'opengrokbot/bot:dev'

const SHIM_PORT = '7717/tcp'
const CDP_PORT = '9222/tcp'
const VNC_PORT = '6080/tcp'

export type Endpoints = { shim: string; cdp: string; vnc: string }

export function containerName(botId: string): string {
  return `opengrokbot-${botId}`
}

export function createContainerSpec(botId: string, workspaceDir: string): Docker.ContainerCreateOptions {
  const loopback = [{ HostIp: '127.0.0.1', HostPort: '' }] // 空 HostPort = Docker 动态分配
  return {
    name: containerName(botId),
    Image: BOT_IMAGE,
    Labels: { 'ai.opengrokbot.bot': botId },
    ExposedPorts: { [SHIM_PORT]: {}, [CDP_PORT]: {}, [VNC_PORT]: {} },
    HostConfig: {
      Binds: [`${workspaceDir}:/workspace`],
      PortBindings: { [SHIM_PORT]: loopback, [CDP_PORT]: loopback, [VNC_PORT]: loopback },
      RestartPolicy: { Name: 'unless-stopped' },
    },
  }
}

export function readEndpoints(inspect: unknown): Endpoints {
  const ports = (inspect as { NetworkSettings?: { Ports?: Record<string, { HostPort?: string }[] | null> } })
    .NetworkSettings?.Ports ?? {}
  const pick = (key: string): string => {
    const hostPort = ports[key]?.[0]?.HostPort
    if (!hostPort) throw new Error(`container port ${key.split('/')[0]} not published`)
    return `http://127.0.0.1:${hostPort}`
  }
  return { shim: pick(SHIM_PORT), cdp: pick(CDP_PORT), vnc: pick(VNC_PORT) }
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
      const res = await fetchImpl(url)
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

export async function ensureContainer(
  docker: Docker,
  botId: string,
  workspaceDir: string,
): Promise<Endpoints> {
  const name = containerName(botId)
  const existing = (await docker.listContainers({ all: true, filters: { name: [name] } }))
    .find((c) => c.Names.includes(`/${name}`))
  let container = existing ? docker.getContainer(existing.Id) : null
  if (container && existing!.State !== 'running') {
    await container.start()
  }
  if (!container) {
    container = await docker.createContainer(createContainerSpec(botId, workspaceDir))
    await container.start()
  }
  const endpoints = readEndpoints(await container.inspect())
  await waitForShim(endpoints.shim)
  await waitForCdp(endpoints.cdp)
  return endpoints
}
