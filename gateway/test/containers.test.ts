import { describe, expect, it } from 'vitest'
import { containerName, createContainerSpec, readEndpoints, waitForCdp, waitForShim } from '../src/containers.js'

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

  it('throws a readable error when a port is unpublished', () => {
    expect(() => readEndpoints({ NetworkSettings: { Ports: { '7717/tcp': [{ HostPort: '1' }] } } }))
      .toThrow(/9222/)
  })
})

describe('createContainerSpec', () => {
  it('binds the workspace and publishes all three ports to loopback only', () => {
    const spec = createContainerSpec('researcher', '/data/workspaces/researcher')
    expect(spec.name).toBe('opengrokbot-researcher')
    expect(spec.Image).toBe('opengrokbot/bot:dev')
    expect(spec.HostConfig!.Binds).toEqual(['/data/workspaces/researcher:/workspace'])
    for (const port of ['7717/tcp', '9222/tcp', '6080/tcp']) {
      expect(spec.HostConfig!.PortBindings![port]).toEqual([{ HostIp: '127.0.0.1', HostPort: '' }])
      expect(spec.ExposedPorts![port]).toEqual({})
    }
    expect(spec.Labels).toMatchObject({ 'ai.opengrokbot.bot': 'researcher' })
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
