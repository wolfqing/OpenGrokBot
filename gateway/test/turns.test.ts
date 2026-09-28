import { describe, expect, it } from 'vitest'
import { createTurnQueue } from '../src/turns.js'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

function gate() {
  let open!: () => void
  const opened = new Promise<void>((r) => { open = r })
  return { open, opened }
}

describe('turn queue', () => {
  it('runs one turn at a time per bot', async () => {
    const q = createTurnQueue(() => {})
    const order: string[] = []
    const first = gate()
    const a = q.run('scout', 'dm:scout', async () => { order.push('a:start'); await first.opened; order.push('a:end') })
    const b = q.run('scout', 'dm:scout', async () => { order.push('b:start') })
    await tick()
    expect(order).toEqual(['a:start'])
    first.open()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('lets different bots work in parallel', async () => {
    const q = createTurnQueue(() => {})
    const started: string[] = []
    const hold = gate()
    const a = q.run('scout', 'dm:scout', async () => { started.push('scout'); await hold.opened })
    const b = q.run('ticker', 'dm:ticker', async () => { started.push('ticker'); await hold.opened })
    await tick()
    expect(started.sort()).toEqual(['scout', 'ticker'])
    hold.open()
    await Promise.all([a, b])
  })

  it('reports thinking once while busy and idle once when drained', async () => {
    const statuses: string[] = []
    const q = createTurnQueue((bot, state) => statuses.push(`${bot}:${state}`))
    await Promise.all([
      q.run('scout', 'dm:scout', async () => { await tick() }),
      q.run('scout', 'dm:scout', async () => { await tick() }),
    ])
    expect(statuses).toEqual(['scout:thinking', 'scout:idle'])
    expect(q.statuses()).toEqual({})
  })

  it('snapshots which bots are busy', async () => {
    const q = createTurnQueue(() => {})
    const hold = gate()
    const done = q.run('scout', 'dm:scout', async () => { await hold.opened })
    expect(q.statuses()).toEqual({ scout: 'thinking' })
    expect(q.isBusy('scout')).toBe(true)
    hold.open()
    await done
    expect(q.isBusy('scout')).toBe(false)
  })

  it('stops a thread: aborts its running turn and drops its queued ones, leaving others alone', async () => {
    const q = createTurnQueue(() => {})
    const ran: string[] = []
    let sawAbort = false
    const running = q.run('scout', 'dm:scout', (signal) => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { sawAbort = true; resolve() })
    }))
    const dropped = q.run('scout', 'dm:scout', async () => { ran.push('dropped') })
    const other = q.run('scout', 'group:crew', async () => { ran.push('group') })
    await tick()
    expect(q.stopThread('dm:scout')).toBe(2)
    await Promise.all([running, dropped, other])
    expect(sawAbort).toBe(true)
    expect(ran).toEqual(['group'])
  })

  it('keeps going after a turn throws', async () => {
    const q = createTurnQueue(() => {})
    const ran: string[] = []
    await Promise.all([
      q.run('scout', 'dm:scout', async () => { throw new Error('boom') }),
      q.run('scout', 'dm:scout', async () => { ran.push('next') }),
    ])
    expect(ran).toEqual(['next'])
  })
})

describe('coalescing', () => {
  it('joins a waiting turn with the same key instead of queuing another', async () => {
    const q = createTurnQueue(() => {})
    const ran: string[] = []
    const hold = gate()
    const busy = q.run('scout', 'dm:scout', async () => { await hold.opened })
    const a = q.run('scout', 'dm:scout', async () => { ran.push('a') }, { coalesceKey: 'dm:scout' })
    const b = q.run('scout', 'dm:scout', async () => { ran.push('b') }, { coalesceKey: 'dm:scout' })
    hold.open()
    await Promise.all([busy, a, b])
    expect(ran).toEqual(['a'])
  })

  it('does not join a turn that is already running', async () => {
    const q = createTurnQueue(() => {})
    const ran: string[] = []
    const hold = gate()
    const a = q.run('scout', 'dm:scout', async () => { ran.push('a'); await hold.opened }, { coalesceKey: 'k' })
    await tick()
    const b = q.run('scout', 'dm:scout', async () => { ran.push('b') }, { coalesceKey: 'k' })
    hold.open()
    await Promise.all([a, b])
    expect(ran).toEqual(['a', 'b'])
  })
})
