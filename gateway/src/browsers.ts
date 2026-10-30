import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

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

/** playwright 下载的 Chromium 在 browsers 目录里长什么样（Chrome for Testing 新布局在前，老布局兜底） */
const DOWNLOADED_LAYOUTS = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
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
  const wanted = (env.OPENGROKBOT_BROWSER ?? '').trim()
  if (wanted) {
    if (!exists(wanted)) throw new Error(`OPENGROKBOT_BROWSER points to ${wanted}, which does not exist`)
    return { executablePath: wanted, source: 'env' }
  }
  for (const candidate of SYSTEM_BROWSERS[opts.platform ?? process.platform] ?? []) {
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
 * 接管登录时要以有窗口的方式打开同一个浏览器。镜像站用 OPENGROKBOT_BROWSER_MIRROR（给 playwright 的下载主机）。
 */
export async function installBrowser(dir: string, opts: {
  mirror?: string
  log?: (line: string) => void
  spawnImpl?: SpawnLike
  cliPath?: string
} & FsDeps = {}): Promise<string> {
  const log = opts.log ?? (() => {})
  const cli = opts.cliPath ?? createRequire(import.meta.url).resolve('playwright-core/cli.js')
  const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir }
  if (opts.mirror) env.PLAYWRIGHT_DOWNLOAD_HOST = opts.mirror
  const spawnImpl = opts.spawnImpl ?? (spawn as unknown as SpawnLike)
  log(`downloading a browser for local teammates into ${dir}${opts.mirror ? ` via ${opts.mirror}` : ''} …`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawnImpl(process.execPath, [cli, 'install', 'chromium', '--no-shell', '--no-progress'], { env, stdio: 'pipe' })
    let tail = ''
    const keep = (chunk: unknown) => { tail = (tail + String(chunk)).slice(-2000) }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`browser download failed (exit ${String(code)}). ${tail.trim().split('\n').slice(-3).join(' ')}`.trim()
        + '\nInstall Google Chrome instead, or point OPENGROKBOT_BROWSER at a Chromium-based browser.'))
    })
  })
  const found = findDownloadedBrowser(dir, opts)
  if (!found) throw new Error(`the browser download finished but no executable turned up under ${dir}`)
  log(`browser ready: ${found}`)
  return found
}
