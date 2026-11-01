import { vi } from 'vitest'

// 等两三个回合答完的测试在 CI 的小 runner 上偶尔要一秒多；vi.waitFor 默认 1 秒在那里不够用，
// 也没有全局配置项，只好在这里换个默认值（和 web 的 asyncUtilTimeout 一致）。条件满足就立刻返回，
// 通过的测试不会变慢；仍低于 5 秒的测试超时，失败时报的还是那条断言。
const waitFor = vi.waitFor.bind(vi)
vi.waitFor = ((callback, options) =>
  waitFor(callback, typeof options === 'number' ? options : { timeout: 3000, ...options })) as typeof vi.waitFor
