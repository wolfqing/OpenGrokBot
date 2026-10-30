import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ShellResult } from './computer.js'

/**
 * 本机模式的命令行：命令跑在操作系统自带的沙箱里——macOS 的 Seatbelt（sandbox-exec），Linux 的 bubblewrap。
 * 承诺只有一条、但说到做到：**命令只能写这位同事自己的文件夹**（和一个专属临时目录）；
 * 数据目录（网关令牌、别的同事的文件、浏览器配置）和常见的密钥目录连读都不行。网络照常，和容器一样。
 * 这不是一台 Linux：装不了软件，也不该改宿主的任何设置。
 */
export type SandboxKind = 'seatbelt' | 'bubblewrap'
export type Sandbox = { kind: SandboxKind; executable: string }

export type Confinement = {
  workspace: string
  /** 这位同事专属的临时目录（TMPDIR 指到这里） */
  tmp: string
  /** 整个数据目录：沙箱里看不见 */
  dataDir: string
  home?: string
}

const DEFAULT_SHELL_MS = 60_000
const MAX_SHELL_MS = 10 * 60_000
const MAX_OUTPUT = 8 * 1024 * 1024

export function detectSandbox(platform: string = process.platform, exists: (p: string) => boolean = existsSync): Sandbox | null {
  if (platform === 'darwin' && exists('/usr/bin/sandbox-exec')) return { kind: 'seatbelt', executable: '/usr/bin/sandbox-exec' }
  if (platform === 'linux') {
    for (const p of ['/usr/bin/bwrap', '/usr/local/bin/bwrap']) if (exists(p)) return { kind: 'bubblewrap', executable: p }
  }
  return null
}

/** 没有沙箱时告诉操作者怎么办 */
export function sandboxHint(platform: string = process.platform): string {
  if (platform === 'linux') return 'Install bubblewrap (apt install bubblewrap, or dnf install bubblewrap), then try again.'
  if (platform === 'darwin') return 'macOS normally ships /usr/bin/sandbox-exec; this machine seems to be missing it.'
  return 'Commands on a local computer need macOS or Linux. On Windows, give this teammate a Docker computer instead.'
}

/** 操作者的密钥和自己浏览器的配置：沙箱里读都不许读 */
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.npmrc', '.docker', 'Library/Keychains',
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Microsoft Edge', '.config/google-chrome']

const sbString = (s: string) => `"${s.replace(/["\\]/g, (ch) => `\\${ch}`)}"`

/** 沙箱比对的是真实路径：macOS 的 /var 是 /private/var 的链接，规则写成链接那边就拦错对象 */
function real(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/** Seatbelt 规则：后写的规则覆盖先写的，所以先放开读、再收紧密钥目录、最后开自己的文件夹 */
export function seatbeltProfile(c: Confinement): string {
  const home = c.home ?? homedir()
  const unreadable = [real(c.dataDir), ...SECRET_DIRS.map((d) => join(home, d))]
  return [
    '(version 1)',
    '(deny default)',
    // 跑程序、发信号、查系统信息、找系统服务、共享内存：命令行工具离不开这些（开发者沙箱也都放）
    '(allow process-exec process-fork signal sysctl-read mach-lookup ipc-posix-shm)',
    '(allow network*)',
    '(allow file-read*)',
    `(deny file-read* ${unreadable.map((p) => `(subpath ${sbString(p)})`).join(' ')})`,
    `(allow file-read* file-write* (subpath ${sbString(real(c.workspace))}) (subpath ${sbString(real(c.tmp))}))`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper") (regex #"^/dev/tty"))',
    '(allow file-ioctl (regex #"^/dev/tty"))',
  ].join('\n')
}

/** bubblewrap：整个根只读，数据目录用空 tmpfs 遮住，再把自己的文件夹和临时目录放回去 */
export function bubblewrapArgs(c: Confinement): string[] {
  const ws = real(c.workspace)
  const tmp = real(c.tmp)
  return [
    '--die-with-parent', '--new-session', '--unshare-all', '--share-net',
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--tmpfs', real(c.dataDir),
    '--bind', ws, ws, '--bind', tmp, tmp,
    '--chdir', ws,
  ]
}

export function sandboxedCommand(sandbox: Sandbox, c: Confinement, cmd: string): { file: string; args: string[] } {
  if (sandbox.kind === 'seatbelt') return { file: sandbox.executable, args: ['-p', seatbeltProfile(c), '/bin/bash', '-c', cmd] }
  return { file: sandbox.executable, args: [...bubblewrapArgs(c), '/bin/bash', '-c', cmd] }
}

/** 超时一律封顶：模型给 0 或一个天文数字，也不能让这台电脑的一条车道永远卡住 */
function shellTimeout(requested: number | undefined): number {
  const ms = Number(requested)
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_SHELL_MS
  return Math.min(ms, MAX_SHELL_MS)
}

/** 命令看到的环境：只给白名单，HOME 和 TMPDIR 都指到它自己的地方，宿主用户的环境变量一个都不漏过去 */
export function sandboxEnv(c: Confinement, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: real(c.workspace),
    TMPDIR: real(c.tmp),
    LANG: base.LANG || 'C.UTF-8',
    TERM: 'dumb',
    ...(base.TZ ? { TZ: base.TZ } : {}),
  }
}

/**
 * 和容器里 shim 的 runShell 同一套脾气：自己的进程组（超时/停止整组杀）、输出封顶、
 * bash 退出后留 300ms 收尾，后台进程占着管道也不卡。
 */
export function runSandboxed(cmd: string, opts: {
  sandbox: Sandbox
  confinement: Confinement
  timeoutMs?: number
  signal?: AbortSignal
  spawnImpl?: typeof spawn
}): Promise<ShellResult> {
  const { file, args } = sandboxedCommand(opts.sandbox, opts.confinement, cmd)
  const spawnImpl = opts.spawnImpl ?? spawn
  return new Promise((resolveShell) => {
    const child = spawnImpl(file, args, {
      cwd: real(opts.confinement.workspace),
      env: sandboxEnv(opts.confinement),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const errOut: Buffer[] = []
    let size = 0
    let timedOut = false
    let settled = false
    let grace: NodeJS.Timeout | undefined
    const collect = (bucket: Buffer[]) => (chunk: Buffer) => {
      if (size >= MAX_OUTPUT) return
      size += chunk.length
      bucket.push(chunk)
    }
    child.stdout?.on('data', collect(out))
    child.stderr?.on('data', collect(errOut))
    const killGroup = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已经结束了 */ }
      }
    }
    const timer = setTimeout(() => { timedOut = true; killGroup() }, shellTimeout(opts.timeoutMs))
    if (opts.signal?.aborted) killGroup()
    else opts.signal?.addEventListener('abort', killGroup, { once: true })
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      opts.signal?.removeEventListener('abort', killGroup)
      for (const stream of [child.stdout, child.stderr]) {
        stream?.removeAllListeners('data')
        stream?.resume()
      }
      const stderr = Buffer.concat(errOut).toString('utf8')
      resolveShell({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: stderr || (timedOut ? 'command timed out' : ''),
        exitCode: typeof code === 'number' ? code : 1,
      })
    }
    child.on('close', (code) => finish(code))
    child.on('exit', (code) => { grace = setTimeout(() => finish(code), 300) })
    child.on('error', (err) => {
      errOut.push(Buffer.from(String(err.message)))
      finish(127)
    })
  })
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * 打开命令行之前先验货：沙箱里写自己的文件夹得成，写数据目录、读网关令牌得败。
 * 哪一条不对就不开——说「有沙箱」却拦不住，比没有沙箱更糟。
 */
export async function sandboxSelfCheck(sandbox: Sandbox, c: Confinement): Promise<{ ok: true } | { ok: false; why: string }> {
  await mkdir(c.workspace, { recursive: true })
  await mkdir(c.tmp, { recursive: true })
  const inside = join(resolve(c.workspace), '.sandbox-probe')
  const outside = join(resolve(c.dataDir), `.sandbox-probe-${process.pid}`)
  const token = join(resolve(c.dataDir), 'auth-token')
  const run = (cmd: string) => runSandboxed(cmd, { sandbox, confinement: c, timeoutMs: 20_000 })
  try {
    const wrote = await run(`echo ok > ${shQuote(inside)}`)
    if (wrote.exitCode !== 0 || !existsSync(inside)) {
      return { ok: false, why: `the sandbox could not even write inside the workspace (${wrote.stderr.trim() || `exit ${wrote.exitCode}`})` }
    }
    await run(`echo x > ${shQuote(outside)}`)
    if (existsSync(outside)) return { ok: false, why: 'the sandbox let a command write outside the workspace' }
    if (existsSync(token)) {
      const read = await run(`cat ${shQuote(token)}`)
      if (read.exitCode === 0 && read.stdout.trim()) return { ok: false, why: 'the sandbox let a command read the gateway token' }
    }
    return { ok: true }
  } finally {
    await rm(inside, { force: true })
    await rm(outside, { force: true })
  }
}
