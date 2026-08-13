// 真 Docker 冒烟：拉起一个 bot 容器，走通 shell / 文件 / 浏览器 / 截图。
// 不进 pnpm test（需要 Docker 且慢）。跑法：
//   pnpm --filter @opengrokbot/gateway run smoke:docker
import { mkdir, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { createDockerComputer } from '../src/computer-docker.js'
import { ensureContainer } from '../src/containers.js'
import { saveScreenshot } from '../src/screenshots.js'

const BOT = process.env.SMOKE_BOT || 'smoke'
const docker = new Docker()

const dataDir = await mkdtemp(join(tmpdir(), 'ogb-smoke-'))
const workspace = join(dataDir, 'workspaces', BOT)
await mkdir(workspace, { recursive: true })

console.log('· starting container…')
const endpoints = await ensureContainer(docker, BOT, workspace)
console.log('  endpoints:', endpoints)

const computer = createDockerComputer(endpoints)
const checks: { name: string; ok: boolean }[] = []
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const shell = await computer.shell('echo hi && pwd')
check('shell', shell.exitCode === 0 && shell.stdout.includes('/workspace'), shell.stdout.trim().replace(/\n/g, ' '))

await computer.writeFile('notes/todo.md', '# from smoke\n')
check('write+read file', (await computer.readFile('notes/todo.md')).includes('from smoke'))

const nav = await computer.goto('https://example.com')
check('browser_goto', /example/i.test(nav.title), `${nav.title} @ ${nav.url}`)

const text = await computer.extract(200)
check('browser_extract', text.toLowerCase().includes('example'), text.slice(0, 60).replace(/\n/g, ' '))

const shot = await computer.screenshot()
const saved = await saveScreenshot(dataDir, BOT, shot, Date.now())
const onDisk = await stat(join(dataDir, 'workspaces', BOT, 'screenshots', saved.url.split('/').pop()!))
check('browser_screenshot', onDisk.size > 5000, `${onDisk.size} bytes, ${shot.width}x${shot.height}`)

await computer.dispose()
console.log(`\ncontainer left running as opengrokbot-${BOT} (docker rm -f opengrokbot-${BOT} to clean up)`)
const failed = checks.filter((c) => !c.ok)
if (failed.length) { console.error(`\n${failed.length} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')
