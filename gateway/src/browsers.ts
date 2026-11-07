import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, win32 } from 'node:path'
import { CodedError } from './coded-error.js'

/**
 * 本机模式要一个 Chromium 系浏览器。顺序：操作者指定的 → 机器上装好的（真 Chrome 优先，登录页对它最宽容）→
 * 我们自己下载到数据目录里的 Chrome for Testing。下载用 playwright-core 自带的安装器，不多装东西。
 */
export type BrowserFound = { executablePath: string; source: 'env' | 'system' | 'downloaded' }

const SYSTEM_BROWSERS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/usr/bin/brave-browser',
  ],
}

/**
 * Windows 上的浏览器：装给所有用户在 Program Files 下，只装给自己（Chrome 的默认）在 LocalAppData 下。
 * 真 Chrome 在每个位置都先找一遍，再找 Edge（每台 Windows 都有），最后 Chromium 和 Brave。
 */
const WINDOWS_BROWSERS = [
  'Google\\Chrome\\Application\\chrome.exe',
  'Microsoft\\Edge\\Application\\msedge.exe',
  'Chromium\\Application\\chrome.exe',
  'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
]

/** 这个平台上该去哪些位置找浏览器（Windows 的位置取决于环境变量） */
export function systemBrowsers(platform: string, env: Record<string, string | undefined>): string[] {
  if (platform !== 'win32') return SYSTEM_BROWSERS[platform] ?? []
  // process.env 在 Windows 上不分大小写，传进来的普通对象（测试、别处拼的 env）分：两种写法都认
  const get = (name: string) => env[name] ?? env[name.toUpperCase()]
  const roots = [...new Set([get('ProgramFiles'), get('ProgramFiles(x86)'), get('LOCALAPPDATA')].filter((r): r is string => Boolean(r)))]
  return WINDOWS_BROWSERS.flatMap((rel) => roots.map((root) => win32.join(root, rel)))
}

/** playwright 下载的 Chromium 在 browsers 目录里长什么样（Chrome for Testing 新布局在前，老布局兜底） */
const DOWNLOADED_LAYOUTS = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-win64/chrome.exe',
  'chrome-win/chrome.exe',
]

export function browsersDir(dataDir: string): string {
  return join(dataDir, 'browsers')
}

type FsDeps = { exists?: (p: string) => boolean; readdir?: (p: string) => string[] }

/** 数据目录里下载过的浏览器：有几个版本就挑最新的那个 */
export function findDownloadedBrowser(dir: string, deps: FsDeps = {}): string | null {
  const exists = deps.exists ?? existsSync
  const readdir = deps.readdir ?? ((p: string) => { try { return readdirSync(p) } catch { return [] } })
  const revisions = readdir(dir)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  for (const rev of revisions) {
    for (const layout of DOWNLOADED_LAYOUTS) {
      const full = join(dir, rev, layout)
      if (exists(full)) return full
    }
  }
  return null
}

export function findBrowser(opts: {
  dataDir: string
  env?: Record<string, string | undefined>
  platform?: string
} & FsDeps): BrowserFound | null {
  const exists = opts.exists ?? existsSync
  const env = opts.env ?? process.env
  const wanted = (env.OPENSUPERBOT_BROWSER ?? '').trim()
  if (wanted) {
    if (!exists(wanted)) throw new CodedError('browser_missing', `OPENSUPERBOT_BROWSER points to ${wanted}, which does not exist`, { path: wanted })
    return { executablePath: wanted, source: 'env' }
  }
  for (const candidate of systemBrowsers(opts.platform ?? process.platform, env)) {
    if (exists(candidate)) return { executablePath: candidate, source: 'system' }
  }
  const downloaded = findDownloadedBrowser(browsersDir(opts.dataDir), opts)
  return downloaded ? { executablePath: downloaded, source: 'downloaded' } : null
}

export type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; stdio: 'pipe' },
) => { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null; on(ev: 'exit' | 'error', cb: (a: unknown) => void): unknown }

/**
 * 下载 Chrome for Testing（约 150 MB）到 browsers 目录。只装完整版、不装 headless shell：
 * 接管登录时要以有窗口的方式打开同一个浏览器。镜像站用 OPENSUPERBOT_BROWSER_MIRROR（给 playwright 的下载主机）。
 */
/** item：在下哪一样（先 chromium、再 ffmpeg，每样都从 0% 走起） */
export type DownloadProgress = { item: string | null; percent: number; totalMiB: number }

/** 安装器没有终端时每 10% 打一行：`|■■■■    |  10% of 185.8 MiB`；每样开头一行 `Downloading … (playwright chromium v1248) from …` */
const PROGRESS = /(\d{1,3})% of ([\d.]+) MiB/
const ITEM = /^Downloading .+ \(playwright ([\w-]+) v\d+\)/

export async function installBrowser(dir: string, opts: {
  mirror?: string
  log?: (line: string) => void
  onProgress?: (p: DownloadProgress) => void
  spawnImpl?: SpawnLike
  cliPath?: string
} & FsDeps = {}): Promise<string> {
  const log = opts.log ?? (() => {})
  // cli.js 不在 playwright-core 的 exports 里，直接 resolve 会报 ERR_PACKAGE_PATH_NOT_EXPORTED：从 package.json 找到包目录再拼
  const cli = opts.cliPath ?? join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js')
  const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir }
  if (opts.mirror) env.PLAYWRIGHT_DOWNLOAD_HOST = opts.mirror
  const spawnImpl = opts.spawnImpl ?? (spawn as unknown as SpawnLike)
  log(`downloading a browser for local teammates into ${dir}${opts.mirror ? ` via ${opts.mirror}` : ''} …`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawnImpl(process.execPath, [cli, 'install', 'chromium', '--no-shell'], { env, stdio: 'pipe' })
    let tail = ''
    let partial = ''
    let item: string | null = null
    const keep = (chunk: unknown) => {
      tail = (tail + String(chunk)).slice(-2000)
      const lines = (partial + String(chunk)).split(/[\r\n]/)
      partial = lines.pop() ?? ''
      for (const line of lines) {
        item = ITEM.exec(line)?.[1] ?? item
        const m = PROGRESS.exec(line)
        if (m) opts.onProgress?.({ item, percent: Number(m[1]), totalMiB: Number(m[2]) })
      }
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else {
        const detail = tail.trim().split('\n').slice(-3).join(' ')
        reject(new CodedError('browser_download_failed', `browser download failed (exit ${String(code)}). ${detail}`.trim()
          + '\nInstall Google Chrome instead, or point OPENSUPERBOT_BROWSER at a Chromium-based browser.', { detail }))
      }
    })
  })
  const found = findDownloadedBrowser(dir, opts)
  if (!found) throw new Error(`the browser download finished but no executable turned up under ${dir}`)
  log(`browser ready: ${found}`)
  return found
}

export type BrowserStatus =
  | { state: 'found'; executablePath: string; source: BrowserFound['source'] }
  | { state: 'missing' }
  | { state: 'downloading'; item: string | null; percent: number | null; totalMiB: number | null }
  | { state: 'failed'; error: string }

export type BrowserProvisioner = {
  status(): BrowserStatus
  /** 找到就用，找不到就下载；同时来的请求共用一次下载 */
  ensure(): Promise<string>
  onChange(listener: (s: BrowserStatus) => void): () => void
}

/**
 * 本机模式的浏览器只有一个来源：第一次要电脑时、向导里点「先下载」时，都走这里，不会两头同时往一个目录里下。
 * 镜像每次下载前现读（向导里刚勾上的镜像不用重启就能用）。
 */
export function createBrowserProvisioner(opts: {
  dataDir: string
  /** OPENSUPERBOT_BROWSER；空 = 自己找 */
  browser: string
  mirror: () => string
  log?: (line: string) => void
  find?: () => BrowserFound | null
  install?: typeof installBrowser
}): BrowserProvisioner {
  const log = opts.log ?? (() => {})
  const find = opts.find ?? (() => findBrowser({ dataDir: opts.dataDir, env: { OPENSUPERBOT_BROWSER: opts.browser } }))
  const install = opts.install ?? installBrowser
  const listeners = new Set<(s: BrowserStatus) => void>()
  let downloading: { item: string | null; percent: number | null; totalMiB: number | null } | null = null
  let lastError = ''
  let inflight: Promise<string> | null = null

  const status = (): BrowserStatus => {
    if (downloading) return { state: 'downloading', ...downloading }
    let found: BrowserFound | null
    try {
      found = find()
    } catch (err) {
      return { state: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    if (found) return { state: 'found', ...found }
    return lastError ? { state: 'failed', error: lastError } : { state: 'missing' }
  }
  const changed = () => {
    const s = status()
    for (const l of listeners) l(s)
  }

  async function provision(): Promise<string> {
    const found = find() // 操作者指定的浏览器不存在时这里直接抛，不去下载
    if (found) {
      log(`local teammates use the ${found.source} browser at ${found.executablePath}`)
      return found.executablePath
    }
    log('no Chromium-based browser on this machine')
    downloading = { item: null, percent: null, totalMiB: null }
    lastError = ''
    changed()
    try {
      const mirror = opts.mirror()
      return await install(browsersDir(opts.dataDir), {
        ...(mirror ? { mirror } : {}),
        log,
        onProgress: (p) => { downloading = p; changed() },
      })
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      downloading = null
      changed()
    }
  }

  return {
    status,
    ensure: () => (inflight ??= provision().finally(() => { inflight = null })),
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
