export type ReportLine = { system: string; result: string; count?: string }
export type ReportPayload = { lines: ReportLine[]; closing?: string }

export function validateReportPayload(input: unknown): ReportPayload | null {
  if (typeof input !== 'object' || input === null) return null
  const p = input as Record<string, unknown>
  if (!Array.isArray(p.lines) || p.lines.length === 0) return null
  const lines: ReportLine[] = []
  for (const raw of p.lines) {
    if (typeof raw !== 'object' || raw === null) return null
    const { system, result, count } = raw as Record<string, unknown>
    if (typeof system !== 'string' || !system.trim()) return null
    if (typeof result !== 'string' || !result.trim()) return null
    if (count !== undefined && typeof count !== 'string') return null
    const line: ReportLine = { system: system.trim(), result: result.trim() }
    if (typeof count === 'string' && count.trim()) line.count = count.trim()
    lines.push(line)
  }
  const closing = typeof p.closing === 'string' && p.closing.trim() ? p.closing.trim() : undefined
  return closing ? { lines, closing } : { lines }
}
