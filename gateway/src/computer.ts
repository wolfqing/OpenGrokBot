export type ShellResult = { stdout: string; stderr: string; exitCode: number }
export type Shot = { buffer: Buffer; width: number; height: number }

/** 一台 bot 自己的电脑：shell、文件、浏览器。实现见 computer-docker.ts。 */
export interface BotComputer {
  shell(cmd: string, timeoutMs?: number): Promise<ShellResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  goto(url: string): Promise<{ url: string; title: string }>
  extract(maxChars?: number): Promise<string>
  click(target: string): Promise<{ clicked: string }>
  screenshot(): Promise<Shot>
  dispose(): Promise<void>
}

// 1x1 PNG，够测试断言"有字节"即可
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export function createFakeComputer(
  overrides: Partial<BotComputer> & { pageText?: string } = {},
): BotComputer & { calls: string[] } {
  const calls: string[] = []
  const pageText = overrides.pageText ?? 'Example Domain — this domain is for use in examples.'
  const base: BotComputer = {
    async shell(cmd) { calls.push(`shell:${cmd}`); return { stdout: 'hi\n', stderr: '', exitCode: 0 } },
    async readFile(path) { calls.push(`read:${path}`); return 'file contents' },
    async writeFile(path) { calls.push(`write:${path}`) },
    async goto(url) { calls.push(`goto:${url}`); return { url, title: 'Example Domain' } },
    async extract(maxChars) { calls.push('extract'); return maxChars ? pageText.slice(0, maxChars) : pageText },
    async click(target) { calls.push(`click:${target}`); return { clicked: target } },
    async screenshot() { calls.push('screenshot'); return { buffer: TINY_PNG, width: 1280, height: 800 } },
    async dispose() { calls.push('dispose') },
  }
  const wrapped: BotComputer = { ...base }
  for (const key of Object.keys(base) as (keyof BotComputer)[]) {
    const override = overrides[key]
    if (typeof override === 'function') {
      wrapped[key] = (async (...args: unknown[]) => {
        calls.push(`${key}:${String(args[0] ?? '')}`.replace(/:$/, ''))
        return (override as (...a: unknown[]) => unknown)(...args)
      }) as never
    }
  }
  return Object.assign(wrapped, { calls })
}
