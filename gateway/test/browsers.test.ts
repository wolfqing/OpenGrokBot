import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findBrowser, findDownloadedBrowser, installBrowser, systemBrowsers, type SpawnLike } from '../src/browsers.js'

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

  it('looks where Windows installs browsers, for all users and for one, Chrome before Edge', () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' }
    const userChrome = 'C:\\Users\\ana\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    expect(findBrowser({ dataDir: 'C:\\data', env, platform: 'win32', exists: have(edge, userChrome) }))
      .toEqual({ executablePath: userChrome, source: 'system' })
    expect(findBrowser({ dataDir: 'C:\\data', env, platform: 'win32', exists: have(edge) })?.executablePath).toBe(edge)
    // process.env 在 Windows 上不分大小写；普通对象里写成全大写也认
    expect(systemBrowsers('win32', { PROGRAMFILES: 'C:\\Program Files' })[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    // 32 位系统上两个 Program Files 是同一个目录：不重复找
    const same = systemBrowsers('win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files' })
    expect(same.filter((p) => p.endsWith('chrome.exe') && p.includes('Google'))).toHaveLength(1)
    expect(systemBrowsers('win32', {})).toEqual([])
  })

  it('falls back to the newest browser we downloaded ourselves, else null', () => {
    // 下载目录里的路径用 join 拼：Windows 上是反斜杠，期望值也照样拼
    const mac = 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    const newest = join('/data', 'browsers', 'chromium-1300', mac)
    const older = join('/data', 'browsers', 'chromium-1248', mac)
    const readdir = () => ['chromium-1248', 'ffmpeg-1013', 'chromium-1300', '.links']
    expect(findBrowser({ dataDir: '/data', env: {}, platform: 'darwin', exists: have(newest, older), readdir }))
      .toEqual({ executablePath: newest, source: 'downloaded' })
    const linux = join('/data/browsers', 'chromium-1248', 'chrome-linux64/chrome')
    expect(findDownloadedBrowser('/data/browsers', { exists: have(linux), readdir })).toBe(linux)
    const windows = join('/data/browsers', 'chromium-1248', 'chrome-win64/chrome.exe')
    expect(findDownloadedBrowser('/data/browsers', { exists: have(windows), readdir })).toBe(windows)
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
    const exe = join('/data/browsers', 'chromium-1248', 'chrome-linux64/chrome')
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

  it('finds playwright-core\'s own installer when no cli path is given', async () => {
    const { spawnImpl, calls } = fakeSpawn(0)
    await installBrowser('/data/browsers', { spawnImpl, exists: () => true, readdir: () => ['chromium-1248'] }).catch(() => {})
    const cli = calls[0]?.args[0] ?? ''
    expect(cli).toMatch(/playwright-core[\\/]cli\.js$/)
    expect(existsSync(cli)).toBe(true)
  })

  it('explains a failed download and what to do instead', async () => {
    const { spawnImpl } = fakeSpawn(1, 'Error: connect ETIMEDOUT cdn.playwright.dev\n')
    await expect(installBrowser('/data/browsers', { spawnImpl, cliPath: '/pw/cli.js', exists: () => false, readdir: () => [] }))
      .rejects.toThrow(/exit 1.*ETIMEDOUT[\s\S]*OPENGROKBOT_BROWSER/)
  })
})
