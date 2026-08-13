import { Cron } from 'croner'
import { isValidCron, type RoutineRow } from './routines.js'

export type CronJob = { stop(): void }
export type CronFactory = (expr: string, onTick: () => void) => CronJob

export type Scheduler = {
  load(routines: RoutineRow[]): void
  add(routine: RoutineRow): void
  stopAll(): void
  size(): number
}

const realCron: CronFactory = (expr, onTick) => new Cron(expr, onTick)

export function createScheduler(deps: {
  run: (routine: RoutineRow) => void | Promise<void>
  makeCron?: CronFactory
}): Scheduler {
  const makeCron = deps.makeCron ?? realCron
  const jobs = new Map<number, CronJob>()

  const stopAll = (): void => {
    for (const job of jobs.values()) job.stop()
    jobs.clear()
  }

  const add = (routine: RoutineRow): void => {
    jobs.get(routine.id)?.stop()
    jobs.delete(routine.id)
    // 停用或表达式坏掉的 routine 只是不排期，不该让整批注册失败
    if (!routine.enabled || !isValidCron(routine.cron)) return
    jobs.set(routine.id, makeCron(routine.cron, () => {
      try {
        void Promise.resolve(deps.run(routine)).catch(() => {})
      } catch { /* 一次触发失败不该停掉这条 routine */ }
    }))
  }

  return {
    add,
    stopAll,
    load(routines) {
      stopAll()
      for (const routine of routines) add(routine)
    },
    size: () => jobs.size,
  }
}
