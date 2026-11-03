import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { findBrowser, findDownloadedBrowser, installBrowser, type SpawnLike } from '../src/browsers.js'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const have = (...paths: string[]) => (p: string) => paths.includes(p)

describe('findBrowser', () => {
  it('takes the operator-specified browser first, and refuses one that is not there', () => {
    expect(findBrowser({ dataDir: '/data', env: { OPENGROKBOT_BROWSER: '/opt/brave' }, exists: have('/opt/brave', CHROME) }))
      .toEqual({ executablePath: '/opt/brave', source: 'env' })
    expect(() => findBrowser({ dataDir: '/data', env: { OPENGROKBOT_BROWSER: '/nope' }, exists: have(CHROME) }))
      .toThrow(/OPENGROKBOT_BROWSER points to \/nope/)
  })

  it('prefers real Chrome, then Edge, on the platform it runs on', () => {
    expect(findBrowser({ dataDir: '/data', env: {}, platform: 'darwin', exists: have(CHROME, EDGE) })?.executablePath).toBe(CHROME)
    expect(findBrowser({ dataDir: '/data', env: {}, platform: 'darwin', exists: have(EDGE) })?.executablePath).toBe(EDGE)
    expect(findBrowser({ dataDir: '/data', env: {}, platform: 'linux', exists: have('/usr/bin/chromium') }))
      .toEqual({ executablePath: '/usr/bin/chromium', source: 'system' })
  })

  it('falls back to the newest browser we downloaded ourselves, else null', () => {
    const newest = '/data/browsers/chromium-1300/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    const older = '/data/browsers/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    const readdir = () => ['chromium-1248', 'ffmpeg-1013', 'chromium-1300', '.links']
    expect(findBrowser({ dataDir: '/data', env: {}, platform: 'darwin', exists: have(newest, older), readdir }))
      .toEqual({ executablePath: newest, source: 'downloaded' })
    expect(findDownloadedBrowser('/data/browsers', { exists: have('/data/browsers/chromium-1248/chrome-linux64/chrome'), readdir }))
      .toBe('/data/browsers/chromium-1248/chrome-linux64/chrome')
    expect(findBrowser({ dataDir: '/data', env: {}, platform: 'darwin', exists: () => false, readdir: () => [] })).toBeNull()
  })
})

function fakeSpawn(exitCode: number, output = ''): { spawnImpl: SpawnLike; calls: { args: string[]; env: NodeJS.ProcessEnv }[] } {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
  const spawnImpl: SpawnLike = (_cmd, args, opts) => {
    calls.push({ args, env: opts.env })
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setTimeout(() => {
      if (output) child.stderr.emit('data', output)
      child.emit('exit', exitCode)
    }, 0)
    return child as never
  }
  return { spawnImpl, calls }
}

describe('installBrowser', () => {
  it('runs playwright-core\'s installer into the data dir, through the mirror when given, and returns the executable', async () => {
    const exe = '/data/browsers/chromium-1248/chrome-linux64/chrome'
    const { spawnImpl, calls } = fakeSpawn(0)
    const lines: string[] = []
    const found = await installBrowser('/data/browsers', {
      spawnImpl, cliPath: '/pw/cli.js', mirror: 'https://cdn.npmmirror.com/binaries/playwright', log: (l) => lines.push(l),
      exists: have(exe), readdir: () => ['chromium-1248'],
    })
    expect(found).toBe(exe)
    expect(calls[0]!.args).toEqual(['/pw/cli.js', 'install', 'chromium', '--no-shell', '--no-progress'])
    expect(calls[0]!.env.PLAYWRIGHT_BROWSERS_PATH).toBe('/data/browsers')
    expect(calls[0]!.env.PLAYWRIGHT_DOWNLOAD_HOST).toBe('https://cdn.npmmirror.com/binaries/playwright')
    expect(lines.join('\n')).toMatch(/downloading a browser/)
  })

  it('explains a failed download and what to do instead', async () => {
    const { spawnImpl } = fakeSpawn(1, 'Error: connect ETIMEDOUT cdn.playwright.dev\n')
    await expect(installBrowser('/data/browsers', { spawnImpl, cliPath: '/pw/cli.js', exists: () => false, readdir: () => [] }))
      .rejects.toThrow(/exit 1.*ETIMEDOUT[\s\S]*OPENGROKBOT_BROWSER/)
  })
})
