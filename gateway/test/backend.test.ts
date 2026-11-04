import { describe, expect, it } from 'vitest'
import type Docker from 'dockerode'
import { chooseBackend, createDockerBackend, dockerReachable, parseComputerChoice, type ComputerBackend } from '../src/backend.js'
import { createFakeComputer } from '../src/computer.js'

function fakeBackend(kind: 'docker' | 'local'): ComputerBackend {
  return { kind, make: async () => createFakeComputer({ kind }), running: async () => [], stop: async () => {} }
}

describe('parseComputerChoice', () => {
  it('defaults to auto and ignores junk', () => {
    expect(parseComputerChoice(undefined)).toBe('auto')
    expect(parseComputerChoice('')).toBe('auto')
    expect(parseComputerChoice('podman')).toBe('auto')
    expect(parseComputerChoice(' Docker ')).toBe('docker')
    expect(parseComputerChoice('LOCAL')).toBe('local')
  })
})

describe('chooseBackend', () => {
  it('takes docker when told to, without asking whether it runs', async () => {
    let probed = false
    const { backend, reason } = await chooseBackend('docker', {
      docker: () => fakeBackend('docker'),
      local: () => fakeBackend('local'),
      dockerReachable: async () => { probed = true; return false },
    })
    expect(backend.kind).toBe('docker')
    expect(reason).toMatch(/OPENGROKBOT_COMPUTERS=docker/)
    expect(probed).toBe(false)
  })

  it('auto: docker when it answers, local when it does not', async () => {
    const opts = { docker: () => fakeBackend('docker'), local: () => fakeBackend('local') }
    expect((await chooseBackend('auto', { ...opts, dockerReachable: async () => true })).backend.kind).toBe('docker')
    const fallback = await chooseBackend('auto', { ...opts, dockerReachable: async () => false })
    expect(fallback.backend.kind).toBe('local')
    expect(fallback.reason).toMatch(/Docker is not running/)
  })

  it('says whether an explicit choice came from the env var or the settings page', async () => {
    const opts = { docker: () => fakeBackend('docker'), local: () => fakeBackend('local'), dockerReachable: async () => true }
    expect(await chooseBackend('local', { ...opts, from: 'saved' })).toMatchObject({ why: 'chosen', reason: 'computers=local in settings' })
    expect(await chooseBackend('docker', { ...opts, from: 'env' })).toMatchObject({ why: 'chosen', reason: 'OPENGROKBOT_COMPUTERS=docker' })
  })

  it('auto: Docker is up but the bot image is not built, so local computers, and says how to build it', async () => {
    const opts = { docker: () => fakeBackend('docker'), local: () => fakeBackend('local'), dockerReachable: async () => true }
    const fallback = await chooseBackend('auto', { ...opts, dockerImageReady: async () => false })
    expect(fallback.backend.kind).toBe('local')
    expect(fallback.why).toBe('docker_image_missing')
    expect(fallback.reason).toMatch(/opengrokbot\/bot:dev is not built.*docker build -t opengrokbot\/bot:dev docker\/bot/)
    expect(await chooseBackend('auto', { ...opts, dockerImageReady: async () => true })).toMatchObject({ why: 'docker_running' })
    expect((await chooseBackend('auto', { ...opts, dockerReachable: async () => false })).why).toBe('docker_not_running')
  })

  it('does not look for the image when Docker is down or the choice is explicit', async () => {
    let looked = 0
    const opts = {
      docker: () => fakeBackend('docker'), local: () => fakeBackend('local'),
      dockerImageReady: async () => { looked++; return false },
    }
    expect((await chooseBackend('auto', { ...opts, dockerReachable: async () => false })).backend.kind).toBe('local')
    // 显式选了 docker：镜像没建照样给 docker，用到时报「怎么建」
    expect((await chooseBackend('docker', { ...opts, dockerReachable: async () => true })).backend.kind).toBe('docker')
    expect(looked).toBe(0)
  })

  it('auto without a local backend still hands out docker, and says why that will hurt', async () => {
    const { backend, reason } = await chooseBackend('auto', {
      docker: () => fakeBackend('docker'),
      local: () => null,
      dockerReachable: async () => false,
    })
    expect(backend.kind).toBe('docker')
    expect(reason).toMatch(/no local mode yet/)
  })

  it('refuses an explicit local choice when no local backend exists', async () => {
    await expect(chooseBackend('local', {
      docker: () => fakeBackend('docker'),
      local: () => null,
      dockerReachable: async () => true,
    })).rejects.toThrow(/no local computer backend/)
  })
})

describe('dockerReachable', () => {
  it('is true when the daemon answers and false when it does not', async () => {
    expect(await dockerReachable({ ping: async () => 'OK' } as unknown as Docker)).toBe(true)
    expect(await dockerReachable({ ping: async () => { throw new Error('ECONNREFUSED') } } as unknown as Docker)).toBe(false)
    expect(await dockerReachable({ ping: () => new Promise(() => {}) } as unknown as Docker, 20)).toBe(false)
  })
})

describe('createDockerBackend', () => {
  it('lists running computers that belong to this data dir and stops by container name', async () => {
    const stopped: string[] = []
    const docker = {
      listContainers: async () => [
        { Labels: { 'ai.opengrokbot.bot': 'researcher', 'ai.opengrokbot.workspace': '/data/workspaces/researcher' } },
        { Labels: { 'ai.opengrokbot.bot': 'stranger', 'ai.opengrokbot.workspace': '/elsewhere/workspaces/stranger' } },
      ],
      getContainer: (name: string) => ({ stop: async () => { stopped.push(name) } }),
    } as unknown as Docker
    const backend = createDockerBackend(docker, { dataDir: '/data' })
    expect(backend.kind).toBe('docker')
    expect(await backend.running()).toEqual(['researcher'])
    await backend.stop('researcher')
    expect(stopped).toEqual(['opengrokbot-researcher'])
  })
})

describe('createLocalBackend.running', () => {
  it('leaves out a computer whose browser has gone away', async () => {
    const { createLocalBackend } = await import('../src/backend.js')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    let open = true
    const browser = {
      contexts: () => [{ pages: () => [], newPage: async () => { throw new Error('no page needed') } }],
      close: async () => { open = false },
      isConnected: () => open,
    }
    const backend = createLocalBackend({
      dataDir: mkdtempSync(join(tmpdir(), 'ogb-backend-')),
      resolveBrowser: async () => '/bin/chrome',
      launch: async () => browser,
    })
    const bob = await backend.make('bob')
    expect(await backend.running()).toEqual(['bob'])
    await expect(bob.goto('https://example.com')).rejects.toThrow() // 开了浏览器（没有页面的假浏览器）
    open = false // 操作者手动退出了 Chrome
    expect(await backend.running()).toEqual([])
  })
})
