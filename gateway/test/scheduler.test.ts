import { describe, expect, it } from 'vitest'
import type { RoutineRow } from '../src/routines.js'
import { createScheduler } from '../src/scheduler.js'

function routine(id: number, cron = '0 9 * * *'): RoutineRow {
  return { id, bot_id: 'market-watch', name: `R${id}`, cron, instructions: 'do it', enabled: 1, created_at: 1, last_run_at: null }
}

/** 假 cron：不看时间，暴露一个手动触发的 tick。 */
function fakeCronFactory() {
  const jobs: { expr: string; tick: () => void; stopped: boolean }[] = []
  const makeCron = (expr: string, onTick: () => void) => {
    const job = { expr, tick: onTick, stopped: false }
    jobs.push(job)
    return { stop() { job.stopped = true } }
  }
  return { jobs, makeCron }
}

describe('createScheduler', () => {
  it('registers one job per routine and fires the callback with the routine', () => {
    const fired: number[] = []
    const { jobs, makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: (r) => { fired.push(r.id) }, makeCron })
    scheduler.load([routine(1), routine(2)])
    expect(scheduler.size()).toBe(2)
    expect(jobs.map((j) => j.expr)).toEqual(['0 9 * * *', '0 9 * * *'])
    jobs[1]!.tick()
    expect(fired).toEqual([2])
  })

  it('load replaces the previous set, stopping the old jobs', () => {
    const { jobs, makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: () => {}, makeCron })
    scheduler.load([routine(1)])
    scheduler.load([routine(2)])
    expect(jobs[0]!.stopped).toBe(true)
    expect(scheduler.size()).toBe(1)
  })

  it('adding the same routine id twice keeps only the newest job', () => {
    const { jobs, makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: () => {}, makeCron })
    scheduler.add(routine(1, '0 9 * * *'))
    scheduler.add(routine(1, '0 17 * * *'))
    expect(jobs[0]!.stopped).toBe(true)
    expect(scheduler.size()).toBe(1)
  })

  it('skips disabled routines and invalid expressions instead of throwing', () => {
    const { makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: () => {}, makeCron })
    scheduler.load([{ ...routine(1), enabled: 0 }, { ...routine(2), cron: 'every morning' }])
    expect(scheduler.size()).toBe(0)
  })

  it('a throwing run callback does not kill the job', () => {
    const { jobs, makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: () => { throw new Error('boom') }, makeCron })
    scheduler.load([routine(1)])
    expect(() => jobs[0]!.tick()).not.toThrow()
  })

  it('stopAll stops everything', () => {
    const { jobs, makeCron } = fakeCronFactory()
    const scheduler = createScheduler({ run: () => {}, makeCron })
    scheduler.load([routine(1), routine(2)])
    scheduler.stopAll()
    expect(jobs.every((j) => j.stopped)).toBe(true)
    expect(scheduler.size()).toBe(0)
  })
})
