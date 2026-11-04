import type { Hono } from 'hono'
import type { BrowserProvisioner } from './browsers.js'
import type { Db } from './db.js'
import type { Hub } from './hub.js'
import type { ComputersInfo } from './server.js'
import type { SettingsDeps } from './settings-api.js'
import { needsSetup, readSavedSettings, resolveSettings } from './settings.js'

export type SetupDeps = {
  browser: BrowserProvisioner
  dockerReachable: () => Promise<boolean>
}

/** 2026-11-03 在 mac-arm64 上实测：下载约 186 MiB，解压后约 369 MB。向导照这个说，不说得更少 */
const DOWNLOAD = { approxMB: 190, onDiskMB: 370 }

/** npmmirror（cnpm 社区维护的国内镜像）同步了 playwright 的浏览器包；只在中国大陆时区时建议 */
const CN_MIRROR = { url: 'https://cdn.npmmirror.com/binaries/playwright', owner: 'npmmirror.com' }
const MAINLAND_ZONES = new Set(['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Urumqi', 'Asia/Kashgar', 'PRC'])

export function mountSetup(app: Hono, deps: SetupDeps & SettingsDeps & { db: Db; hub: Hub; computers?: ComputersInfo }): void {
  const { db, env, startedWith, browser } = deps
  browser.onChange((status) => deps.hub.broadcast({ type: 'setup.browser', browser: status }))

  app.get('/api/setup', async (c) => {
    const { values } = resolveSettings(env, readSavedSettings(db))
    const sandbox = deps.computers?.sandbox ?? { available: false }
    return c.json({
      needsSetup: needsSetup(env, db, startedWith.dataDir),
      demo: values.model === 'stub',
      computers: {
        kind: deps.computers?.kind ?? 'docker',
        choice: values.computers,
        docker: { reachable: await deps.dockerReachable() },
        browser: browser.status(),
        download: DOWNLOAD,
        browserMirror: { current: values.browserMirror, suggested: MAINLAND_ZONES.has(startedWith.timeZone) ? CN_MIRROR : null },
        sandbox,
      },
    })
  })

  // 向导里提前下载：已经有了就直接说有；在下就接着等同一次；进度和结果经 /ws 推 setup.browser
  app.post('/api/setup/browser', (c) => {
    if (browser.status().state === 'found') return c.json({ browser: browser.status() })
    void browser.ensure().catch(() => {}) // 失败落在 status 里（state: failed），这里不用再报
    return c.json({ browser: browser.status() }, 202)
  })
}
