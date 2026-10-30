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
