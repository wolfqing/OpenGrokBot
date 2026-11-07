import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createBrowserProvisioner, findBrowser, findDownloadedBrowser, installBrowser, systemBrowsers, type BrowserStatus, type SpawnLike,
} from '../src/browsers.js'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const have = (...paths: string[]) => (p: string) => paths.includes(p)

describe('findBrowser', () => {
  it('takes the operator-specified browser first, and refuses one that is not there', () => {
    expect(findBrowser({ dataDir: '/data', env: { OPENSUPERBOT_BROWSER: '/opt/brave' }, exists: have('/opt/brave', CHROME) }))
      .toEqual({ executablePath: '/opt/brave', source: 'env' })
    expect(() => findBrowser({ dataDir: '/data', env: { OPENSUPERBOT_BROWSER: '/nope' }, exists: have(CHROME) }))
      .toThrow(/OPENSUPERBOT_BROWSER points to \/nope/)
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
    expect(calls[0]!.args).toEqual(['/pw/cli.js', 'install', 'chromium', '--no-shell'])
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
      .rejects.toThrow(/exit 1.*ETIMEDOUT[\s\S]*OPENSUPERBOT_BROWSER/)
  })
})

describe('download progress', () => {
  it('reports the installer\'s 10% steps (its output without a terminal)', async () => {
    const out = 'Downloading Chrome for Testing 156.0.8078.4 (playwright chromium v1248) from https://cdn.npmmirror.com/x.zip\n'
      + '|                    |   0% of 185.8 MiB\n|■■■■                |  10% of 185.8 MiB\n|■■■■■■■■            | 100% of 185.8 MiB\n'
      + 'Downloading FFmpeg (playwright ffmpeg v1011) from https://cdn.npmmirror.com/y.zip\n|■■■■                |  10% of 1.2 MiB\n'
    const { spawnImpl } = fakeSpawn(0, out)
    const seen: { item: string | null; percent: number; totalMiB: number }[] = []
    await installBrowser('/data/browsers', {
      spawnImpl, cliPath: '/pw/cli.js', exists: () => true, readdir: () => ['chromium-1248'], onProgress: (p) => seen.push(p),
    })
    // 安装器先下浏览器、再下 FFmpeg，每样都从 0% 走起：标上是哪一样，界面就不会以为倒退了
    expect(seen).toEqual([
      { item: 'chromium', percent: 0, totalMiB: 185.8 }, { item: 'chromium', percent: 10, totalMiB: 185.8 },
      { item: 'chromium', percent: 100, totalMiB: 185.8 }, { item: 'ffmpeg', percent: 10, totalMiB: 1.2 },
    ])
  })
})

describe('createBrowserProvisioner', () => {
  const found = { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', source: 'system' as const }

  it('reports what it finds without downloading anything', async () => {
    const install = vi.fn()
    const p = createBrowserProvisioner({ dataDir: '/data', browser: '', mirror: () => '', find: () => found, install })
    expect(p.status()).toEqual({ state: 'found', ...found })
    expect(await p.ensure()).toBe(found.executablePath)
    expect(install).not.toHaveBeenCalled()
  })

  it('downloads once however many ask at the same time, with the mirror set at that moment, and says how far along it is', async () => {
    let have: typeof found | null = null
    let finish!: () => void
    let mirror = ''
    const install = vi.fn(async (_dir: string, opts?: { mirror?: string; onProgress?: (p: { item: string | null; percent: number; totalMiB: number }) => void }) => {
      opts?.onProgress?.({ item: 'chromium', percent: 40, totalMiB: 185.8 })
      await new Promise<void>((r) => { finish = r })
      have = { executablePath: '/data/browsers/chromium-1248/chrome-linux64/chrome', source: 'downloaded' as never }
      return have.executablePath
    })
    const p = createBrowserProvisioner({ dataDir: '/data', browser: '', mirror: () => mirror, find: () => have, install })
    const changes: BrowserStatus[] = []
    p.onChange((s) => changes.push(s))
    expect(p.status()).toEqual({ state: 'missing' })
    mirror = 'https://cdn.npmmirror.com/binaries/playwright' // 向导里刚勾上镜像
    const a = p.ensure()
    const b = p.ensure()
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1))
    expect(install.mock.calls[0]![0]).toBe('/data/browsers')
    expect(install.mock.calls[0]![1]?.mirror).toBe('https://cdn.npmmirror.com/binaries/playwright')
    expect(p.status()).toEqual({ state: 'downloading', item: 'chromium', percent: 40, totalMiB: 185.8 })
    finish()
    expect(await a).toBe('/data/browsers/chromium-1248/chrome-linux64/chrome')
    expect(await b).toBe('/data/browsers/chromium-1248/chrome-linux64/chrome')
    expect(p.status()).toMatchObject({ state: 'found', source: 'downloaded' })
    expect(changes.map((c) => c.state)).toEqual(['downloading', 'downloading', 'found'])
  })

  it('keeps a failed download visible and lets the next ask try again', async () => {
    const install = vi.fn().mockRejectedValueOnce(new Error('browser download failed (exit 1). ETIMEDOUT'))
    let have: typeof found | null = null
    const p = createBrowserProvisioner({ dataDir: '/data', browser: '', mirror: () => '', find: () => have, install })
    await expect(p.ensure()).rejects.toThrow(/ETIMEDOUT/)
    expect(p.status()).toEqual({ state: 'failed', error: 'browser download failed (exit 1). ETIMEDOUT' })
    install.mockImplementationOnce(async () => { have = { ...found, executablePath: '/data/b/chrome' }; return '/data/b/chrome' })
    expect(await p.ensure()).toBe('/data/b/chrome')
    expect(p.status()).toMatchObject({ state: 'found' })
  })

  it('reports a browser setting that points nowhere as a failure, without downloading', async () => {
    const install = vi.fn()
    const p = createBrowserProvisioner({ dataDir: '/data', browser: '/opt/nope', mirror: () => '', install })
    expect(p.status()).toMatchObject({ state: 'failed', error: expect.stringMatching(/OPENSUPERBOT_BROWSER points to \/opt\/nope/) })
    await expect(p.ensure()).rejects.toThrow(/\/opt\/nope/)
    expect(install).not.toHaveBeenCalled()
  })
})
