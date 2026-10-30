import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bubblewrapArgs, detectSandbox, runSandboxed, sandboxEnv, sandboxHint, sandboxSelfCheck, sandboxedCommand, seatbeltProfile,
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
  it('Seatbelt: deny by default, read most things, never the data dir or key folders, write only its own folders', () => {
    const profile = seatbeltProfile(c)
    expect(profile.startsWith('(version 1)\n(deny default)')).toBe(true)
    expect(profile).toContain('(allow network*)')
    expect(profile).toMatch(/\(deny file-read\* \(subpath "\/data"\) \(subpath "\/Users\/op\/.ssh"\)/)
    expect(profile).toContain('(subpath "/Users/op/Library/Application Support/Google/Chrome")')
    expect(profile).toContain('(allow file-read* file-write* (subpath "/data/workspaces/bob") (subpath "/data/bots/bob/tmp"))')
    // 自己的文件夹的放行写在数据目录的禁令之后：Seatbelt 以后写的为准
    expect(profile.indexOf('(deny file-read*')).toBeLessThan(profile.indexOf('(allow file-read* file-write*'))
  })

  it('bubblewrap: read-only root, the data dir hidden under a tmpfs, its own folders bound back in, network kept', () => {
    const args = bubblewrapArgs(c)
    expect(args.slice(0, 4)).toEqual(['--die-with-parent', '--new-session', '--unshare-all', '--share-net'])
    expect(args.join(' ')).toContain('--ro-bind / /')
    expect(args.indexOf('/data')).toBeGreaterThan(-1)
    expect(args[args.indexOf('/data') - 1]).toBe('--tmpfs')
    expect(args.indexOf('--tmpfs')).toBeLessThan(args.indexOf('--bind'))
    expect(args.join(' ')).toContain('--bind /data/workspaces/bob /data/workspaces/bob')
    expect(args.slice(-2)).toEqual(['--chdir', '/data/workspaces/bob'])
  })

  it('hands the command to bash inside the sandbox, with a scrubbed environment', () => {
    expect(sandboxedCommand({ kind: 'seatbelt', executable: '/usr/bin/sandbox-exec' }, c, 'ls -la'))
      .toMatchObject({ file: '/usr/bin/sandbox-exec', args: ['-p', expect.stringContaining('(version 1)'), '/bin/bash', '-c', 'ls -la'] })
    expect(sandboxedCommand({ kind: 'bubblewrap', executable: '/usr/bin/bwrap' }, c, 'ls').args.slice(-3)).toEqual(['/bin/bash', '-c', 'ls'])
    const env = sandboxEnv(c, { LANG: 'zh_CN.UTF-8', TZ: 'Asia/Shanghai', AWS_SECRET_ACCESS_KEY: 'nope', HOME: '/Users/op' })
    expect(env).toEqual({
      PATH: expect.stringContaining('/usr/bin'), HOME: '/data/workspaces/bob', TMPDIR: '/data/bots/bob/tmp',
      LANG: 'zh_CN.UTF-8', TERM: 'dumb', TZ: 'Asia/Shanghai',
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

describe('sandboxSelfCheck', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ogb-sb-')) })
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
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ogb-sb-real-')) })
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
