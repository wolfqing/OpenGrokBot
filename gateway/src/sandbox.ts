import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ShellResult } from './computer.js'

/**
 * 本机模式的命令行：命令跑在操作系统自带的沙箱里——macOS 的 Seatbelt（sandbox-exec），Linux 的 bubblewrap。
 * 两条承诺，两个平台一样：**只能写这位同事自己的文件夹**（和一个专属临时目录）；
 * **看不见操作者的家目录**（密钥、文档、别的项目、浏览器配置、网关的数据目录都在里面），
 * 只有装运行时的那几个目录（~/.nvm、~/.volta、~/.pyenv…）例外，否则 node/python 都找不到。
 * 系统目录（/usr、/opt、/Library…）可读，网络照常，和容器一样。这不是一台 Linux：装不了软件，也不该改宿主的任何设置。
 */
export type SandboxKind = 'seatbelt' | 'bubblewrap'
export type Sandbox = { kind: SandboxKind; executable: string }

export type Confinement = {
  workspace: string
  /** 这位同事专属的临时目录（TMPDIR 指到这里） */
  tmp: string
  /** 整个数据目录：沙箱里看不见（通常在家目录下，已经被遮住；放在别处时单独遮） */
  dataDir: string
  home?: string
  /** 测试里换掉「这个目录存在吗」 */
  exists?: (p: string) => boolean
}

const DEFAULT_SHELL_MS = 60_000
const MAX_SHELL_MS = 10 * 60_000
const MAX_OUTPUT = 8 * 1024 * 1024

/**
 * 家目录里放运行时的目录：沙箱里只读可见。只收版本管理器和它们装的二进制，
 * 不收会藏令牌的配置目录（~/.cargo 整个不行——credentials.toml 在里面，只给 ~/.cargo/bin）。
 */
export const TOOLCHAIN_DIRS = [
  '.nvm', '.volta', '.fnm', '.n', '.bun', '.deno',
  '.pyenv', '.rbenv', '.rustup', '.cargo/bin', 'go/bin', '.ghcup', '.sdkman',
  '.local/share/pnpm', 'Library/pnpm', '.local/bin',
]

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

const sbString = (s: string) => `"${s.replace(/["\\]/g, (ch) => `\\${ch}`)}"`

/** 沙箱比对的是真实路径：macOS 的 /var 是 /private/var 的链接，规则写成链接那边就拦错对象 */
function real(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/** 从根到 p 的每一级目录（不含根）：到工作区去的路上每一级都得允许看元数据，不然连 cd 都进不去 */
function ancestors(p: string): string[] {
  const out: string[] = []
  for (let dir = dirname(p); dir !== dirname(dir); dir = dirname(dir)) out.unshift(dir)
  return out
}

type Resolved = { home: string; dataDir: string; workspace: string; tmp: string; toolchains: string[]; hiddenDataDir: boolean }

function layout(c: Confinement): Resolved {
  const exists = c.exists ?? existsSync
  const home = real(c.home ?? homedir())
  const dataDir = real(c.dataDir)
  return {
    home, dataDir,
    workspace: real(c.workspace),
    tmp: real(c.tmp),
    toolchains: TOOLCHAIN_DIRS.map((d) => join(home, d)).filter((d) => exists(d)),
    // 数据目录在家目录下就已经一起遮住了；在别处才单独遮
    hiddenDataDir: dataDir === home || dataDir.startsWith(home + '/'),
  }
}

/** Seatbelt 规则：后写的规则覆盖先写的——先放开读、再整个遮住家目录（和数据目录）、最后把工具链和自己的文件夹放回来 */
export function seatbeltProfile(c: Confinement): string {
  const l = layout(c)
  const unreadable = [l.home, ...(l.hiddenDataDir ? [] : [l.dataDir])]
  const traversable = [...new Set([...ancestors(l.workspace), ...ancestors(l.tmp)])]
  return [
    '(version 1)',
    '(deny default)',
    // 跑程序、发信号、查系统信息、找系统服务、共享内存：命令行工具离不开这些（开发者沙箱也都放）
    '(allow process-exec process-fork signal sysctl-read mach-lookup ipc-posix-shm)',
    '(allow network*)',
    '(allow file-read*)',
    `(deny file-read* ${unreadable.map((p) => `(subpath ${sbString(p)})`).join(' ')})`,
    `(allow file-read-metadata ${traversable.map((p) => `(literal ${sbString(p)})`).join(' ')})`,
    ...(l.toolchains.length ? [`(allow file-read* ${l.toolchains.map((p) => `(subpath ${sbString(p)})`).join(' ')})`] : []),
    `(allow file-read* file-write* (subpath ${sbString(l.workspace)}) (subpath ${sbString(l.tmp)}))`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper") (regex #"^/dev/tty"))',
    '(allow file-ioctl (regex #"^/dev/tty"))',
  ].join('\n')
}

/** bubblewrap：整个根只读，家目录（和数据目录）用空 tmpfs 遮住，再把工具链只读、自己的文件夹可写地放回去 */
export function bubblewrapArgs(c: Confinement): string[] {
  const l = layout(c)
  return [
    '--die-with-parent', '--new-session', '--unshare-all', '--share-net',
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--tmpfs', l.home,
    ...(l.hiddenDataDir ? [] : ['--tmpfs', l.dataDir]),
    ...l.toolchains.flatMap((d) => ['--ro-bind', d, d]),
    '--bind', l.workspace, l.workspace, '--bind', l.tmp, l.tmp,
    '--chdir', l.workspace,
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

/**
 * 命令看到的环境：只给白名单，HOME 和 TMPDIR 都指到它自己的地方，宿主用户的环境变量一个都不漏过去。
 * PATH 里先放网关自己这个 node 所在的目录：用 nvm 之类装的 node 不在系统路径上，没有这一条 bot 就没有 node。
 */
export function sandboxEnv(c: Confinement, base: NodeJS.ProcessEnv = process.env, nodeDir = dirname(process.execPath)): NodeJS.ProcessEnv {
  return {
    PATH: `${nodeDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
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
 * 打开命令行之前先验货：沙箱里写自己的文件夹得成；写数据目录、读网关令牌、列家目录都得败。
 * 哪一条不对就不开——说「有沙箱」却拦不住，比没有沙箱更糟。
 */
export async function sandboxSelfCheck(sandbox: Sandbox, c: Confinement): Promise<{ ok: true } | { ok: false; why: string }> {
  await mkdir(c.workspace, { recursive: true })
  await mkdir(c.tmp, { recursive: true })
  const l = layout(c)
  const inside = join(l.workspace, '.sandbox-probe')
  const outside = join(l.dataDir, `.sandbox-probe-${process.pid}`)
  const token = join(l.dataDir, 'auth-token')
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
    // Seatbelt 下 ls 直接报错；bubblewrap 下看到的是空的 tmpfs——两种都不该列出任何东西
    const home = await run(`ls -A ${shQuote(l.home)} 2>/dev/null`)
    if (home.stdout.trim()) return { ok: false, why: 'the sandbox let a command read your home directory' }
    return { ok: true }
  } finally {
    await rm(inside, { force: true })
    await rm(outside, { force: true })
  }
}
