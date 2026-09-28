/**
 * 每个 bot 一条车道：同一时刻只跑一个回合。两个回合同时开同一台电脑的浏览器只会互相踩，
 * 而且先结束的那个会把「思考中」提前熄灭。状态灯由车道发：忙起来亮一次，排空了灭一次。
 */
export type TurnJob = (signal: AbortSignal) => Promise<void>
export type TurnState = 'thinking' | 'idle'

type Entry = {
  threadId: string
  job: TurnJob
  controller: AbortController
  resolve: () => void
  done: Promise<void>
  coalesceKey?: string
}
type Lane = { running: Entry | null; waiting: Entry[] }

export type TurnQueue = {
  /**
   * 排队执行；回合结束（或被停掉）时兑现。回合自己负责把错误变成线程里的消息。
   * 带 coalesceKey 时，若已有同 key 的回合还在排队（没开跑），就并进去：它开跑时会看到所有已落库的消息。
   */
  run(laneId: string, threadId: string, job: TurnJob, opts?: { coalesceKey?: string }): Promise<void>
  /** 停掉某个线程的工作：正在跑的收到 abort，排着队的直接丢弃。返回受影响的回合数。 */
  stopThread(threadId: string): number
  statuses(): Record<string, TurnState>
  isBusy(laneId: string): boolean
}

export function createTurnQueue(onStatus: (laneId: string, state: TurnState) => void): TurnQueue {
  const lanes = new Map<string, Lane>()

  async function drain(laneId: string, lane: Lane): Promise<void> {
    onStatus(laneId, 'thinking')
    while (lane.waiting.length > 0) {
      const entry = lane.waiting.shift()!
      lane.running = entry
      try {
        await entry.job(entry.controller.signal)
      } catch (err) {
        console.error(`[turns] ${laneId} turn failed:`, err)
      }
      lane.running = null
      entry.resolve()
    }
    lanes.delete(laneId)
    onStatus(laneId, 'idle')
  }

  return {
    run(laneId, threadId, job, opts = {}) {
      const lane = lanes.get(laneId)
      const twin = opts.coalesceKey ? lane?.waiting.find((e) => e.coalesceKey === opts.coalesceKey) : undefined
      if (twin) return twin.done
      let resolve!: () => void
      const done = new Promise<void>((r) => { resolve = r })
      const entry: Entry = { threadId, job, controller: new AbortController(), resolve, done, coalesceKey: opts.coalesceKey }
      if (lane) {
        lane.waiting.push(entry)
      } else {
        const fresh: Lane = { running: null, waiting: [entry] }
        lanes.set(laneId, fresh)
        void drain(laneId, fresh)
      }
      return done
    },
    stopThread(threadId) {
      let stopped = 0
      for (const lane of lanes.values()) {
        if (lane.running?.threadId === threadId && !lane.running.controller.signal.aborted) {
          lane.running.controller.abort()
          stopped++
        }
        const keep: Entry[] = []
        for (const entry of lane.waiting) {
          if (entry.threadId === threadId) {
            entry.resolve()
            stopped++
          } else {
            keep.push(entry)
          }
        }
        lane.waiting = keep
      }
      return stopped
    },
    statuses: () => Object.fromEntries([...lanes.keys()].map((id) => [id, 'thinking' as const])),
    isBusy: (laneId) => lanes.has(laneId),
  }
}
