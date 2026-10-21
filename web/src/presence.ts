import type { BotStatus } from './types'

type Statuses = Record<string, BotStatus>

/**
 * 网关说某位同事回到 idle：如果它刚才在干活、而你没在看它的线程，就记成「done」，
 * 等你点开它的线程再消掉。你正看着的，干完了你自己就看见了，不用再提示。
 */
export function applyStatus(prev: Statuses, botId: string, state: BotStatus, watching: boolean): Statuses {
  const next = state === 'idle' && prev[botId] === 'thinking' && !watching ? 'done' : state
  return { ...prev, [botId]: next }
}

/** 重连时的快照只有网关知道的状态；界面自己记的「done」不该被它抹掉 */
export function applyHello(prev: Statuses, snapshot: Statuses): Statuses {
  const kept: Statuses = {}
  for (const [id, state] of Object.entries(prev)) if (state === 'done' && !snapshot[id]) kept[id] = 'done'
  return { ...kept, ...snapshot }
}

/** 点开一个线程：里面每位同事的「done」都看过了 */
export function clearDone(prev: Statuses, members: string[]): Statuses {
  if (!members.some((id) => prev[id] === 'done')) return prev
  const next = { ...prev }
  for (const id of members) if (next[id] === 'done') next[id] = 'idle'
  return next
}
