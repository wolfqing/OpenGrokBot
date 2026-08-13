import { describe, expect, it } from 'vitest'
import { createFakeComputer } from '../src/computer.js'
import { createPool } from '../src/pool.js'

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
