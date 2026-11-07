import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bubblewrapArgs, detectSandbox, homeLeaks, runSandboxed, sandboxEnv, sandboxHint, sandboxSelfCheck, sandboxedCommand, seatbeltProfile,
} from '../src/sandbox.js'

const have = (...paths: string[]) => (p: string) => paths.includes(p)
const c = { workspace: '/data/workspaces/bob', tmp: '/data/bots/bob/tmp', dataDir: '/data', home: '/Users/op' }

describe('detectSandbox', () => {
  it('finds Seatbelt on macOS and bubblewrap on Linux, else nothing (with advice)', () => {
    expect(detectSandbox('darwin', have('/usr/bin/sandbox-exec'))).toEqual({ kind: 'seatbelt', executable: '/usr/bin/sandbox-exec' })
    expect(detectSandbox('linux', have('/usr/bin/bwrap'))).toEqual({ kind: 'bubblewrap', executable: '/usr/bin/bwrap' })
    expect(detectSandbox('linux', () => false)).toBeNull()
    expect(detectSandbox('win32', () => true)).toBeNull()
    expect(sandboxHint('linux')).toMatch(/bubblewrap/)
    expect(sandboxHint('win32')).toMatch(/Docker/)
  })
})

describe('the confinement rules', () => {
  const cHome = { ...c, exists: (p: string) => ['/Users/op/.nvm', '/Users/op/.cargo/bin'].includes(p) }

  it('Seatbelt: deny by default; read the system but not the home dir; see the way to the workspace; toolchains read-only; write only its own folders', () => {
    const profile = seatbeltProfile(cHome)
    expect(profile.startsWith('(version 1)\n(deny default)')).toBe(true)
    expect(profile).toContain('(allow network*)')
    expect(profile).toContain('(allow file-read*)\n(deny file-read* (subpath "/Users/op") (subpath "/data"))')
    expect(profile).toContain('(allow file-read-metadata (literal "/data") (literal "/data/workspaces") (literal "/data/bots") (literal "/data/bots/bob"))')
    expect(profile).toContain('(allow file-read* (subpath "/Users/op/.nvm") (subpath "/Users/op/.cargo/bin"))')
    expect(profile).not.toContain('"/Users/op/.cargo")') // 整个 .cargo 不给：credentials.toml 在里面
    expect(profile).toContain('(allow file-read* file-write* (subpath "/data/workspaces/bob") (subpath "/data/bots/bob/tmp"))')
    // 放行写在禁令之后：Seatbelt 以后写的为准
    expect(profile.indexOf('(deny file-read*')).toBeLessThan(profile.indexOf('(allow file-read* (subpath'))
    expect(profile.indexOf('(deny file-read*')).toBeLessThan(profile.indexOf('(allow file-read* file-write*'))
  })

  it('Seatbelt: a data dir under the home dir is hidden by the home rule alone', () => {
    const under = { workspace: '/Users/op/osb/data/workspaces/bob', tmp: '/Users/op/osb/data/bots/bob/tmp', dataDir: '/Users/op/osb/data', home: '/Users/op', exists: () => false }
    const profile = seatbeltProfile(under)
    expect(profile).toContain('(deny file-read* (subpath "/Users/op"))')
    expect(profile).toContain('(literal "/Users/op/osb/data/workspaces")')
    expect(profile).not.toContain('(allow file-read* (subpath')
  })

  it('bubblewrap: read-only root, the home dir (and a data dir elsewhere) hidden under tmpfs, toolchains read-only, its own folders bound back in, network kept', () => {
    const args = bubblewrapArgs(cHome)
    expect(args.slice(0, 4)).toEqual(['--die-with-parent', '--new-session', '--unshare-all', '--share-net'])
    const joined = args.join(' ')
    expect(joined).toContain('--ro-bind / /')
    expect(joined).toContain('--tmpfs /Users/op --tmpfs /data')
    expect(joined).toContain('--ro-bind /Users/op/.nvm /Users/op/.nvm --ro-bind /Users/op/.cargo/bin /Users/op/.cargo/bin')
    expect(joined).toContain('--bind /data/workspaces/bob /data/workspaces/bob --bind /data/bots/bob/tmp /data/bots/bob/tmp')
    // 遮住在前、放回在后：挂载顺序就是优先级
    expect(args.indexOf('--tmpfs')).toBeLessThan(args.indexOf('--ro-bind', 5))
    expect(args.lastIndexOf('--tmpfs')).toBeLessThan(args.indexOf('--bind'))
    expect(args.slice(-2)).toEqual(['--chdir', '/data/workspaces/bob'])
    const under = bubblewrapArgs({ workspace: '/home/op/osb/data/workspaces/bob', tmp: '/home/op/osb/data/bots/bob/tmp', dataDir: '/home/op/osb/data', home: '/home/op', exists: () => false })
    expect(under.filter((a) => a === '--tmpfs')).toHaveLength(2) // /tmp 和家目录；数据目录在家里，不用再遮
  })

  it('hands the command to bash inside the sandbox, with a scrubbed environment that still finds this node', () => {
    expect(sandboxedCommand({ kind: 'seatbelt', executable: '/usr/bin/sandbox-exec' }, c, 'ls -la'))
      .toMatchObject({ file: '/usr/bin/sandbox-exec', args: ['-p', expect.stringContaining('(version 1)'), '/bin/bash', '-c', 'ls -la'] })
    expect(sandboxedCommand({ kind: 'bubblewrap', executable: '/usr/bin/bwrap' }, c, 'ls').args.slice(-3)).toEqual(['/bin/bash', '-c', 'ls'])
    const env = sandboxEnv(c, { LANG: 'zh_CN.UTF-8', TZ: 'Asia/Shanghai', AWS_SECRET_ACCESS_KEY: 'nope', HOME: '/Users/op' }, '/Users/op/.nvm/versions/node/v24/bin')
    expect(env).toEqual({
      PATH: '/Users/op/.nvm/versions/node/v24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/data/workspaces/bob', TMPDIR: '/data/bots/bob/tmp', LANG: 'zh_CN.UTF-8', TERM: 'dumb', TZ: 'Asia/Shanghai',
    })
  })
})

/** 假沙箱：一个忽略规则、直接跑命令的脚本——用来证明自检能揭穿「拦不住的沙箱」 */
function leakySandbox(dir: string) {
  const script = join(dir, 'leaky-sandbox.sh')
  writeFileSync(script, '#!/bin/sh\nshift 2\nexec "$@"\n')
  chmodSync(script, 0o755)
  return { kind: 'seatbelt' as const, executable: script }
}

// 假沙箱是个 #!/bin/sh 脚本；Windows 上没有沙箱，自检也就从来不跑
describe.skipIf(process.platform === 'win32')('sandboxSelfCheck', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'osb-sb-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('refuses a sandbox that lets a command write outside the workspace', async () => {
    const confinement = { workspace: join(dir, 'data/workspaces/bob'), tmp: join(dir, 'data/bots/bob/tmp'), dataDir: join(dir, 'data') }
    const result = await sandboxSelfCheck(leakySandbox(dir), confinement)
    expect(result).toEqual({ ok: false, why: expect.stringMatching(/write outside/) })
    expect(existsSync(join(dir, 'data', `.sandbox-probe-${process.pid}`))).toBe(false) // 探针清理掉了
  })
})

const realSeatbelt = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
describe.skipIf(!realSeatbelt)('Seatbelt for real (macOS only)', () => {
  let dir: string
  const sandbox = { kind: 'seatbelt' as const, executable: '/usr/bin/sandbox-exec' }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'osb-sb-real-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const confinementIn = (root: string) => ({ workspace: join(root, 'data/workspaces/bob'), tmp: join(root, 'data/bots/bob/tmp'), dataDir: join(root, 'data') })

  it('lets a command work in its folder, and stops it writing elsewhere or reading the gateway token', async () => {
    const c = confinementIn(dir)
    await sandboxSelfCheck(sandbox, c) // creates the folders
    writeFileSync(join(c.dataDir, 'auth-token'), 'secret-token')
    const ok = await runSandboxed('echo hello > note.txt && cat note.txt && echo "$HOME"', { sandbox, confinement: c })
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout).toContain('hello')
    expect(ok.stdout).toMatch(/workspaces\/bob/)
    expect(readFileSync(join(c.workspace, 'note.txt'), 'utf8')).toBe('hello\n')
    const outside = await runSandboxed(`echo x > "${join(c.dataDir, 'leak.txt')}"`, { sandbox, confinement: c })
    expect(outside.exitCode).not.toBe(0)
    expect(existsSync(join(c.dataDir, 'leak.txt'))).toBe(false)
    const token = await runSandboxed(`cat "${join(c.dataDir, 'auth-token')}"`, { sandbox, confinement: c })
    expect(token.exitCode).not.toBe(0)
    expect(token.stdout).not.toContain('secret-token')
    const home = await runSandboxed(`ls -A "${process.env.HOME}"; cat "${process.env.HOME}/.zshrc" "${process.env.HOME}/.bashrc" 2>&1 | head -c 300`, { sandbox, confinement: c })
    expect(home.stdout).not.toMatch(/Documents|Library|\.ssh/)
    expect(home.stdout).toMatch(/Operation not permitted|No such file/)
    const node = await runSandboxed('node -e "console.log(21*2)" && echo "$PATH"', { sandbox, confinement: c })
    expect(node.stdout).toContain('42')
    expect(await sandboxSelfCheck(sandbox, c)).toEqual({ ok: true })
  }, 60_000)

  it('kills the whole process group on timeout and on stop', async () => {
    const c = confinementIn(dir)
    await sandboxSelfCheck(sandbox, c)
    const started = Date.now()
    const slow = await runSandboxed('sleep 30; echo late', { sandbox, confinement: c, timeoutMs: 1_000 })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(slow.stderr).toMatch(/timed out/)
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 300)
    const stopped = await runSandboxed('sleep 30', { sandbox, confinement: c, signal: ctrl.signal })
    expect(stopped.exitCode).not.toBe(0)
  }, 60_000)
})

describe('homeLeaks', () => {
  const home = '/home/ana'
  const putBack = ['/home/ana/.cargo/bin', '/home/ana/.local/bin', '/home/ana/Projects/OpenSuperBot/gateway/data/workspaces/bob']

  it('ignores the mount points the sandbox binds back itself', () => {
    // bubblewrap 的空家目录里，绑回来的工具链和工作区会留下它们的第一层名字
    expect(homeLeaks('.cargo\n.local\nProjects\n', home, putBack)).toEqual([])
    expect(homeLeaks('', home, putBack)).toEqual([])
  })

  it('reports anything else it can see in the home directory', () => {
    expect(homeLeaks('.cargo\n.ssh\nDocuments\n.opensuperbot-sandbox-probe-42\n', home, putBack))
      .toEqual(['.ssh', 'Documents', '.opensuperbot-sandbox-probe-42'])
  })

  it('does not treat paths outside the home directory as put back', () => {
    expect(homeLeaks('tmp\n', home, ['/tmp/osb/workspaces/bob'])).toEqual(['tmp'])
  })
})
