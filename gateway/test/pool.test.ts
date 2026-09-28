import { describe, expect, it } from 'vitest'
import { createFakeComputer } from '../src/computer.js'
import { createPool, reapIdleComputers } from '../src/pool.js'

describe('createPool', () => {
  it('starts one computer per bot and reuses it', async () => {
    let made = 0
    const pool = createPool({ dataDir: '/data', makeComputer: async () => { made += 1; return createFakeComputer() } })
    const a = await pool.get('researcher')
    const b = await pool.get('researcher')
    expect(a).toBe(b)
    expect(made).toBe(1)
    await pool.get('market-watch')
    expect(made).toBe(2)
  })

  it('dedupes concurrent starts for the same bot', async () => {
    let made = 0
    const pool = createPool({
      dataDir: '/data',
      makeComputer: async () => { made += 1; await new Promise((r) => setTimeout(r, 20)); return createFakeComputer() },
    })
    const [a, b] = await Promise.all([pool.get('researcher'), pool.get('researcher')])
    expect(a).toBe(b)
    expect(made).toBe(1)
  })

  it('does not cache failures — a later call retries', async () => {
    let calls = 0
    const pool = createPool({
      dataDir: '/data',
      makeComputer: async () => {
        calls += 1
        if (calls === 1) throw new Error('docker daemon not running')
        return createFakeComputer()
      },
    })
    await expect(pool.get('researcher')).rejects.toThrow(/docker daemon/)
    await expect(pool.get('researcher')).resolves.toBeTruthy()
    expect(calls).toBe(2)
  })

  it('disposeAll disposes every live computer', async () => {
    const made: ReturnType<typeof createFakeComputer>[] = []
    const pool = createPool({ dataDir: '/data', makeComputer: async () => { const c = createFakeComputer(); made.push(c); return c } })
    await pool.get('researcher')
    await pool.get('market-watch')
    await pool.disposeAll()
    expect(made.map((c) => c.calls)).toEqual([['dispose'], ['dispose']])
  })
})

describe('a restarted container', () => {
  it('is replaced once its computer stops answering', async () => {
    let made = 0
    let alive = true
    const pool = createPool({
      dataDir: '/data',
      makeComputer: async () => {
        made += 1
        return createFakeComputer({ ping: async () => alive })
      },
    })
    const first = await pool.get('researcher')
    expect(await pool.get('researcher')).toBe(first) // 活着就复用
    expect(made).toBe(1)

    alive = false // 容器重启，端口全变了
    const second = await pool.get('researcher')
    expect(second).not.toBe(first)
    expect(made).toBe(2)
  })

  it('disposes the dead computer instead of leaking its connection', async () => {
    const made: ReturnType<typeof createFakeComputer>[] = []
    const pool = createPool({
      dataDir: '/data',
      makeComputer: async () => {
        const nth = made.length // 第一台假装已经随容器重启死掉了
        const c = createFakeComputer({ ping: async () => nth > 0 })
        made.push(c)
        return c
      },
    })
    await pool.get('researcher')
    await pool.get('researcher')
    expect(made[0]!.calls).toContain('dispose')
  })
})

describe('idle computers', () => {
  it('remembers when each computer was last used and can forget one', async () => {
    let clock = 1000
    const computer = createFakeComputer()
    const pool = createPool({ dataDir: '/data', makeComputer: async () => computer, now: () => clock })
    expect(pool.lastUsed('researcher')).toBeUndefined()
    await pool.get('researcher')
    expect(pool.lastUsed('researcher')).toBe(1000)
    clock = 5000
    await pool.get('researcher')
    expect(pool.lastUsed('researcher')).toBe(5000)
    await pool.forget('researcher')
    expect(computer.calls).toContain('dispose')
  })

  it('stops computers nobody used for a while, but never one that is working', async () => {
    const HOUR = 3_600_000
    let clock = 10 * HOUR
    const pool = createPool({ dataDir: '/data', makeComputer: async () => createFakeComputer(), now: () => clock })
    clock = 7 * HOUR
    await pool.get('researcher') // 3 小时前用过
    clock = 10 * HOUR - 5 * 60_000
    await pool.get('market-watch') // 5 分钟前用过
    clock = 10 * HOUR
    const stopped: string[] = []
    const reaped = await reapIdleComputers({
      pool,
      idleMs: HOUR,
      runningBots: async () => ['researcher', 'market-watch', 'chief', 'inbox-keeper'],
      isBusy: (id) => id === 'inbox-keeper',
      stop: async (id) => { stopped.push(id) },
      now: clock,
      startedAt: 8 * HOUR, // chief 自网关启动（2 小时前）就没被用过
    })
    expect(reaped.sort()).toEqual(['chief', 'researcher'])
    expect(stopped.sort()).toEqual(['chief', 'researcher'])
  })
})

describe('stopping a computer that is wanted again', () => {
  it('waits for the stop to finish before starting it again, instead of handing out a dying computer', async () => {
    const order: string[] = []
    let finishStop!: () => void
    const stopped = new Promise<void>((r) => { finishStop = r })
    const pool = createPool({ dataDir: '/data', makeComputer: async () => { order.push('make'); return createFakeComputer() } })
    await pool.get('researcher')
    order.length = 0
    const retiring = pool.retire('researcher', async () => { order.push('stop:start'); await stopped; order.push('stop:end') })
    const wanted = pool.get('researcher')
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['stop:start'])
    finishStop()
    await Promise.all([retiring, wanted])
    expect(order).toEqual(['stop:start', 'stop:end', 'make'])
  })
})
