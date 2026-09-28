import { describe, expect, it } from 'vitest'
import {
  BOT_NETWORK, SPEC_VERSION, containerName, createContainerSpec, ensureContainer, readEndpoints, runningBotIds,
  stopBotContainer, waitForCdp, waitForShim,
} from '../src/containers.js'

const inspect = {
  NetworkSettings: {
    Ports: {
      '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '53314' }],
      '7717/tcp': [{ HostIp: '127.0.0.1', HostPort: '53312' }],
      '9222/tcp': [{ HostIp: '127.0.0.1', HostPort: '53313' }],
    },
  },
}

describe('containerName', () => {
  it('namespaces by bot id', () => {
    expect(containerName('researcher')).toBe('opengrokbot-researcher')
  })
})

describe('readEndpoints', () => {
  it('maps published ports to loopback urls', () => {
    expect(readEndpoints(inspect)).toEqual({
      shim: 'http://127.0.0.1:53312',
      cdp: 'http://127.0.0.1:53313',
      vnc: 'http://127.0.0.1:53314',
    })
  })

  it('reads the per-container secrets back from its environment', () => {
    const withEnv = { ...inspect, Config: { Env: ['PATH=/usr/bin', 'SHIM_TOKEN=tok-123', 'VNC_PASSWORD=pw12345x'] } }
    expect(readEndpoints(withEnv)).toMatchObject({ shimToken: 'tok-123', vncPassword: 'pw12345x' })
  })

  it('throws a readable error when a port is unpublished', () => {
    expect(() => readEndpoints({ NetworkSettings: { Ports: { '7717/tcp': [{ HostPort: '1' }] } } }))
      .toThrow(/9222/)
  })
})

const secrets = { shimToken: 'tok-123', vncPassword: 'pw12345x' }

describe('createContainerSpec', () => {
  it('binds the workspace and publishes all three ports to loopback only', () => {
    const spec = createContainerSpec('researcher', '/data/workspaces/researcher', secrets)
    expect(spec.name).toBe('opengrokbot-researcher')
    expect(spec.Image).toBe('opengrokbot/bot:dev')
    expect(spec.HostConfig!.Binds).toEqual(['/data/workspaces/researcher:/workspace'])
    for (const port of ['7717/tcp', '9222/tcp', '6080/tcp']) {
      expect(spec.HostConfig!.PortBindings![port]).toEqual([{ HostIp: '127.0.0.1', HostPort: '' }])
      expect(spec.ExposedPorts![port]).toEqual({})
    }
    expect(spec.Labels).toMatchObject({
      'ai.opengrokbot.bot': 'researcher',
      'ai.opengrokbot.spec': SPEC_VERSION,
      'ai.opengrokbot.workspace': '/data/workspaces/researcher',
    })
  })

  it('cages the computer: isolated network, resource limits, no privilege escalation', () => {
    const spec = createContainerSpec('researcher', '/w', secrets, { memoryMb: 1024, cpus: 1.5 })
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: BOT_NETWORK,
      Memory: 1024 * 1024 * 1024,
      NanoCpus: 1_500_000_000,
      PidsLimit: 512,
      Init: true,
    })
    expect(spec.HostConfig!.SecurityOpt).toContain('no-new-privileges')
  })

  it('always binds an absolute host path, never a volume name', () => {
    const spec = createContainerSpec('researcher', 'data-stub/workspaces/researcher', secrets)
    expect(spec.HostConfig!.Binds![0]).toMatch(/^\/.+\/data-stub\/workspaces\/researcher:\/workspace$/)
  })

  it('hands the container its secrets and the gateway timezone', () => {
    const spec = createContainerSpec('researcher', '/w', secrets, { timeZone: 'Asia/Shanghai' })
    expect(spec.Env).toEqual(expect.arrayContaining(['SHIM_TOKEN=tok-123', 'VNC_PASSWORD=pw12345x', 'TZ=Asia/Shanghai']))
  })
})

type Info = {
  Id: string; Names: string[]; State: string; ImageID: string; Labels: Record<string, string>
  Mounts?: { Source: string; Destination: string }[]
}

/** 假 docker：记录调用，按需返回容器/网络/镜像。 */
function fakeDocker(opts: { containers?: Info[]; networks?: string[]; imageId?: string; createError?: Error } = {}) {
  const log: string[] = []
  const networks = [...(opts.networks ?? [])]
  let lastSpec: { Env?: string[] } = {}
  const ports = inspect.NetworkSettings
  const docker = {
    listNetworks: async () => networks.map((Name) => ({ Name })),
    createNetwork: async (spec: { Name: string; Options: Record<string, string> }) => {
      log.push(`network:${spec.Name}:icc=${spec.Options['com.docker.network.bridge.enable_icc']}`)
      networks.push(spec.Name)
    },
    listContainers: async () => opts.containers ?? [],
    getContainer: (id: string) => ({
      start: async () => { log.push(`start:${id}`) },
      stop: async () => { log.push(`stop:${id}`) },
      remove: async () => { log.push(`remove:${id}`) },
      inspect: async () => ({ NetworkSettings: ports, Config: { Env: lastSpec.Env ?? ['SHIM_TOKEN=old', 'VNC_PASSWORD=oldpass1'] } }),
    }),
    createContainer: async (spec: { name: string; Env?: string[] }) => {
      if (opts.createError) throw opts.createError
      log.push(`create:${spec.name}`)
      lastSpec = spec
      return docker.getContainer('new')
    },
    getImage: () => ({ inspect: async () => ({ Id: opts.imageId ?? 'sha256:current' }) }),
  }
  return { docker: docker as never, log }
}

const ok = (async () => new Response('{}')) as typeof fetch
// Docker Desktop（macOS）的列表接口把挂载路径报成虚拟机里的 /host_mnt/…，所以归属看标签，不看这个路径
const running = (extra: Partial<Info> = {}): Info => ({
  Id: 'c1', Names: ['/opengrokbot-researcher'], State: 'running', ImageID: 'sha256:current',
  Labels: { 'ai.opengrokbot.bot': 'researcher', 'ai.opengrokbot.spec': SPEC_VERSION, 'ai.opengrokbot.workspace': '/w' },
  Mounts: [{ Source: '/host_mnt/w', Destination: '/workspace' }], ...extra,
})

describe('ensureContainer', () => {
  it('creates the isolated bot network once, with container-to-container traffic off', async () => {
    const { docker, log } = fakeDocker()
    await ensureContainer(docker, 'researcher', '/w', { fetchImpl: ok })
    expect(log[0]).toBe(`network:${BOT_NETWORK}:icc=false`)
    const again = fakeDocker({ networks: [BOT_NETWORK] })
    await ensureContainer(again.docker, 'researcher', '/w', { fetchImpl: ok })
    expect(again.log.some((l) => l.startsWith('network:'))).toBe(false)
  })

  it('creates a fresh computer with its own random secrets', async () => {
    const { docker, log } = fakeDocker({ networks: [BOT_NETWORK] })
    const endpoints = await ensureContainer(docker, 'researcher', '/w', { fetchImpl: ok })
    expect(log).toEqual(['create:opengrokbot-researcher', 'start:new'])
    expect(endpoints.shimToken!.length).toBeGreaterThanOrEqual(24)
    expect(endpoints.vncPassword).toMatch(/^[A-Za-z0-9]{8}$/)
  })

  it('reuses a running computer built from the current spec and image', async () => {
    const { docker, log } = fakeDocker({ networks: [BOT_NETWORK], containers: [running()] })
    await ensureContainer(docker, 'researcher', '/w', { fetchImpl: ok })
    expect(log).toEqual([])
  })

  it('rebuilds a computer created by an older gateway (no cage, no secrets)', async () => {
    const { docker, log } = fakeDocker({
      networks: [BOT_NETWORK], containers: [running({ Labels: { 'ai.opengrokbot.bot': 'researcher' } })],
    })
    await ensureContainer(docker, 'researcher', '/w', { fetchImpl: ok })
    expect(log).toEqual(['remove:c1', 'create:opengrokbot-researcher', 'start:new'])
  })

  it('rebuilds a computer when the bot image has been rebuilt', async () => {
    const { docker, log } = fakeDocker({ networks: [BOT_NETWORK], containers: [running({ ImageID: 'sha256:old' })] })
    await ensureContainer(docker, 'researcher', '/w', { fetchImpl: ok })
    expect(log).toEqual(['remove:c1', 'create:opengrokbot-researcher', 'start:new'])
  })

  it('rebuilds a computer that another gateway (another data dir) created', async () => {
    const { docker, log } = fakeDocker({
      networks: [BOT_NETWORK],
      containers: [running({
        Labels: { 'ai.opengrokbot.bot': 'researcher', 'ai.opengrokbot.spec': SPEC_VERSION, 'ai.opengrokbot.workspace': '/other/workspaces/researcher' },
      })],
    })
    await ensureContainer(docker, 'researcher', '/w', { fetchImpl: ok })
    expect(log).toEqual(['remove:c1', 'create:opengrokbot-researcher', 'start:new'])
  })

  it('turns a missing image into the command that fixes it', async () => {
    const error = Object.assign(new Error('(HTTP code 404) no such container - No such image: opengrokbot/bot:dev'), { statusCode: 404 })
    const { docker } = fakeDocker({ networks: [BOT_NETWORK], createError: error })
    await expect(ensureContainer(docker, 'researcher', '/w', { fetchImpl: ok }))
      .rejects.toThrow(/docker build -t opengrokbot\/bot:dev docker\/bot/)
  })
})

describe('docker not running', () => {
  it('says Docker is not running instead of surfacing a socket error', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED /Users/me/.docker/run/docker.sock'), { code: 'ECONNREFUSED' })
    const docker = { listNetworks: async () => { throw refused } } as never
    await expect(ensureContainer(docker, 'researcher', '/w', { fetchImpl: ok })).rejects.toThrow(/Docker is not running/)
  })
})

describe('runningBotIds', () => {
  it('only counts computers that belong to this gateway\'s data dir', async () => {
    const mine = running({
      Labels: { 'ai.opengrokbot.bot': 'researcher', 'ai.opengrokbot.workspace': '/data/workspaces/researcher' },
      Mounts: [{ Source: '/host_mnt/data/workspaces/researcher', Destination: '/workspace' }],
    })
    const theirs = running({
      Id: 'c2', Names: ['/opengrokbot-chief'],
      Labels: { 'ai.opengrokbot.bot': 'chief', 'ai.opengrokbot.workspace': '/elsewhere/workspaces/chief' },
    })
    const { docker } = fakeDocker({ containers: [mine, theirs] })
    expect(await runningBotIds(docker, '/data')).toEqual(['researcher'])
  })
})

describe('stopBotContainer', () => {
  it('stops the named computer', async () => {
    const { docker, log } = fakeDocker()
    await stopBotContainer(docker, 'researcher')
    expect(log).toEqual(['stop:opengrokbot-researcher'])
  })
})

describe('waitForShim', () => {
  it('resolves once health returns ok, retrying failures', async () => {
    let n = 0
    const fakeFetch = (async () => {
      n += 1
      if (n < 3) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ ok: true }))
    }) as typeof fetch
    await waitForShim('http://127.0.0.1:1', 5000, fakeFetch)
    expect(n).toBe(3)
  })

  it('rejects with a readable error after the timeout', async () => {
    const fakeFetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    await expect(waitForShim('http://127.0.0.1:1', 300, fakeFetch)).rejects.toThrow(/never became ready/)
  })
})

describe('waitForCdp', () => {
  it('polls the devtools version endpoint until it answers', async () => {
    const seen: string[] = []
    let n = 0
    const fakeFetch = (async (url: string | URL | Request) => {
      seen.push(String(url))
      n += 1
      if (n < 2) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ Browser: 'Chrome/151.0.0.0' }))
    }) as typeof fetch
    await waitForCdp('http://127.0.0.1:9222', 5000, fakeFetch)
    expect(seen).toEqual(['http://127.0.0.1:9222/json/version', 'http://127.0.0.1:9222/json/version'])
  })

  it('names the browser in its timeout error', async () => {
    const fakeFetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    await expect(waitForCdp('http://127.0.0.1:1', 300, fakeFetch)).rejects.toThrow(/browser never became ready/)
  })
})
