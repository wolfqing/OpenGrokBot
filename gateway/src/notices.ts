/**
 * 网关以同事的名义往线程里发的固定话（停下了、出错了、超预算、到上限暂停）。
 * 消息照旧是 kind 'text'、content 是英文——模型的历史和老界面都看 content；
 * payload 带一个 code + 参数，界面按操作者的语言重新说一遍。
 */
export type Notice =
  | { notice: 'stopped' }
  | { notice: 'error'; params: { name: string; detail: string } }
  | { notice: 'budget'; params: { name: string; used: number; budget: number } }
  | {
    notice: 'paused'
    params: { limit: 'steps' | 'minutes' | 'seconds'; count: number }
    /** 模型收尾时交代的那几行（它自己的话，不翻） */
    lead?: string
  }

/** checkBudget 可以只回一句话（老写法），也可以连数字一起回，界面才翻得了 */
export type BudgetHit = { text: string; name: string; used: number; budget: number }

const count = (n: number) => n.toLocaleString('en-US')

export function noticeText(n: Notice): string {
  switch (n.notice) {
    case 'stopped': return '⏹ Stopped. Tell me when to pick it back up.'
    case 'error': return `⚠️ ${n.params.name} hit an error: ${n.params.detail}`
    case 'budget':
      return `⚠️ ${n.params.name} hit today's token budget (${count(n.params.used)} of ${count(n.params.budget)} tokens). `
        + 'It picks up again tomorrow — or raise OPENSUPERBOT_DAILY_TOKENS.'
    case 'paused': {
      const notice = `⏸ Paused at ${limitText(n.params.limit, n.params.count)}. Say "continue" to pick it up.`
      return n.lead ? `${n.lead}\n\n${notice}` : notice
    }
  }
}

/** 给模型和日志的英文：「the 30-step limit for one turn」 */
export function limitText(limit: 'steps' | 'minutes' | 'seconds', n: number): string {
  const unit = limit === 'steps' ? 'step' : limit === 'minutes' ? 'minute' : 'second'
  return `the ${n}-${unit} limit for one turn`
}
