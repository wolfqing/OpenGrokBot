/** bot 转发 bot 的最大跳数：够一次分派 + 一次回话，再多就是回声。 */
export const MAX_HOPS = 2

export type A2ARules = { chiefId: string; pairs: [string, string][] }

/** `researcher>market-watch,market-watch>researcher` → 有向对。畸形项直接丢掉，不让配置错误变成运行时异常。 */
export function parseA2AAllow(spec: string, chiefId: string): A2ARules {
  const pairs: [string, string][] = []
  for (const item of spec.split(',')) {
    const [from, to] = item.split('>').map((s) => s.trim())
    if (from && to) pairs.push([from, to])
  }
  return { chiefId, pairs }
}

export function canMessage(rules: A2ARules, from: string, to: string): boolean {
  if (!from || !to || from === to) return false
  if (from === rules.chiefId || to === rules.chiefId) return true
  return rules.pairs.some(([a, b]) => a === from && b === to)
}

export function denyReason(rules: A2ARules, from: string, to: string): string {
  if (from === to) return 'You cannot message yourself.'
  return `Messaging ${to} is not allowlisted for you. Ask your operator to allow it, or route it through ${rules.chiefId}.`
}
