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

export async function waitForShim(
  shimUrl: string,
  timeoutMs = 60_000,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`${shimUrl}/health`)
      if (res.ok) return
      lastError = `health returned ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`bot container never became ready at ${shimUrl}: ${lastError}`)
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
  return endpoints
}
