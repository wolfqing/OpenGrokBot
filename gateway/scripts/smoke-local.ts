// 本机模式冒烟：真浏览器（机器上的 Chrome/Edge，或自动下载的 Chrome for Testing）+ 真沙箱
// （macOS Seatbelt / Linux bubblewrap）。走通文件 / 浏览器 / 截屏流 / 登录窗口 / 命令行开关与沙箱边界。
// 不进 pnpm test（要真浏览器且慢）。跑法：
//   pnpm --filter @opengrokbot/gateway run smoke:local
import { existsSync } from 'node:fs'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalBackend } from '../src/backend.js'
import { detectSandbox, sandboxSelfCheck } from '../src/sandbox.js'
import { saveScreenshot } from '../src/screenshots.js'

const BOT = process.env.SMOKE_BOT || 'smoke'
const dataDir = await mkdtemp(join(tmpdir(), 'ogb-smoke-local-'))
await writeFile(join(dataDir, 'auth-token'), 'smoke-secret-token\n', { mode: 0o600 })

const checks: { name: string; ok: boolean }[] = []
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const rejects = async (p: Promise<unknown>, re: RegExp) => {
  try { await p; return false } catch (err) { return re.test(err instanceof Error ? err.message : String(err)) }
}

let shellOn = false
const sandbox = detectSandbox()
console.log(`· data dir ${dataDir}; sandbox: ${sandbox?.kind ?? 'none'}`)
const backend = createLocalBackend({ dataDir, log: (line) => console.log(`  ${line}`), shell: { enabled: () => shellOn, sandbox } })
const computer = await backend.make(BOT)
check('a local computer', computer.kind === 'local' && (await computer.ping()))

await computer.writeFile('notes/todo.md', '# from smoke\n')
check('write+read file', (await computer.readFile('/workspace/notes/todo.md')).includes('from smoke'))
check('files cannot leave the workspace', await rejects(computer.readFile('../../auth-token'), /escapes/) && await rejects(computer.readFile('/etc/passwd'), /escapes/))

const started = Date.now()
const nav = await computer.goto('https://example.com')
check('browser_goto (first launch)', /example/i.test(nav.title), `${nav.title} in ${Date.now() - started} ms`)
const text = await computer.extract()
check('browser_extract', text.toLowerCase().includes('example'), text.slice(0, 60).replace(/\n/g, ' '))
const links = await computer.links()
check('links on the page', links.some((l) => l.href.startsWith('http')), links.slice(0, 2).map((l) => l.href).join(', '))

await computer.goto('data:text/html,<label>Search <input id=q></label><p id=echo></p>'
  + '<script>q.oninput=()=>echo.textContent=q.value</script>')
await computer.type('Search', '你好 grok')
check('browser_type by label', (await computer.extract()).includes('你好 grok'))

const shot = await computer.screenshot()
const saved = await saveScreenshot(dataDir, BOT, shot, Date.now())
const onDisk = await stat(join(dataDir, 'bots', BOT, 'screenshots', saved.url.split('/').pop()!))
check('browser_screenshot', onDisk.size > 2000, `${onDisk.size} bytes, ${shot.width}x${shot.height}`)

const frames: number[] = []
const stop = await computer.screencast!((f) => frames.push(f.data.length))
await computer.goto('https://example.com')
await new Promise((r) => setTimeout(r, 2000))
await stop()
check('screencast frames arrive while the page changes', frames.length >= 1, `${frames.length} frames, first ${frames[0] ?? 0} chars`)

await computer.showWindow!()
const shownAt = (await computer.goto('https://example.com/')).url
check('a window for signing in, on the same page', computer.windowShown!() === true && /example\.com/.test(shownAt), shownAt)
await computer.hideWindow!()
check('back to headless, page kept', computer.windowShown!() === false && (await computer.extract()).toLowerCase().includes('example'))

check('commands are off by default', await rejects(computer.shell('id'), /Commands are off/))
if (sandbox) {
  const workspace = join(dataDir, 'workspaces', BOT)
  const self = await sandboxSelfCheck(sandbox, { workspace, tmp: join(dataDir, 'bots', BOT, 'tmp'), dataDir })
  check('sandbox self-check', self.ok, self.ok ? sandbox.kind : self.why)
  shellOn = true
  const hi = await computer.shell('echo hi && pwd && echo "$HOME"')
  check('shell runs in the workspace', hi.exitCode === 0 && hi.stdout.includes('hi') && hi.stdout.includes(`workspaces/${BOT}`), hi.stdout.trim().replace(/\n/g, ' '))
  const leak = await computer.shell(`echo x > "${join(dataDir, 'leak.txt')}"; echo exit=$?`)
  check('shell cannot write outside the workspace', !existsSync(join(dataDir, 'leak.txt')), leak.stdout.trim())
  const token = await computer.shell(`cat "${join(dataDir, 'auth-token')}"`)
  check('shell cannot read the gateway token', token.exitCode !== 0 && !token.stdout.includes('smoke-secret'), token.stderr.trim().slice(0, 60))
  const home = await computer.shell('ls ~/.ssh 2>&1 | head -1; cat ~/.ssh/id_rsa 2>&1 | head -c 20')
  check('shell cannot read the operator\'s keys (HOME is the workspace)', !home.stdout.includes('BEGIN'), home.stdout.trim().slice(0, 60))
  const net = await computer.shell('curl -sS -o /dev/null -w "%{http_code}" --max-time 10 https://example.com || echo curl-failed')
  check('shell keeps network access', /200|curl-failed/.test(net.stdout), net.stdout.trim())
  const t0 = Date.now()
  const slow = await computer.shell('sleep 20; echo late', 1_000)
  check('a slow command is killed on timeout', /timed out/.test(slow.stderr) && Date.now() - t0 < 10_000, `${Date.now() - t0} ms`)
  shellOn = false
  check('switch off takes effect at once', await rejects(computer.shell('id'), /Commands are off/))
} else {
  console.log('  (no sandbox on this machine — shell checks skipped)')
}

check('backend lists it as running', (await backend.running()).includes(BOT))
await backend.stop(BOT)
check('stop closes the browser and forgets it', !(await backend.running()).includes(BOT))
const again = await backend.make(BOT)
const back = await again.goto('https://example.com')
check('comes back with the same profile', /example/i.test(back.title) && existsSync(join(dataDir, 'bots', BOT, 'browser', 'Default')))
await backend.stop(BOT)

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) { console.error(`${failed.length} check(s) failed`); process.exit(1) }
