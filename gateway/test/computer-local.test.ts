import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalBackend } from '../src/backend.js'
import type { BrowserLike } from '../src/browser-page.js'
import { createLocalComputer, workspacePath, type LocalLaunch } from '../src/computer-local.js'

let dir: string
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'ogb-local-'))) })
afterEach(() => rm(dir, { recursive: true, force: true }))

function fakeBrowser() {
  const state = { url: 'about:blank', open: true, launches: [] as { profileDir: string; executablePath: string; headless: boolean }[] }
  const page = {
    async goto(url: string) { state.url = url },
    async title() { return 'Example Domain' },
    url: () => state.url,
    async innerText() { return 'Example Domain' },
    async screenshot() { return Buffer.from('PNG') },
    async click() {},
    viewportSize: () => ({ width: 1280, height: 800 }),
  }
  const browser: BrowserLike = {
    contexts: () => [{ pages: () => [page], newPage: async () => page }],
    close: async () => { state.open = false },
    isConnected: () => state.open,
  }
  const launch: LocalLaunch = async (opts) => { state.launches.push(opts); state.open = true; return browser }
  return { state, launch }
}

describe('workspacePath', () => {
  it('maps relative paths and /workspace/... into the folder, and refuses everything else', () => {
    expect(workspacePath('/data/workspaces/bob', 'notes.md')).toBe('/data/workspaces/bob/notes.md')
    expect(workspacePath('/data/workspaces/bob', '/workspace/out/report.md')).toBe('/data/workspaces/bob/out/report.md')
    expect(workspacePath('/data/workspaces/bob', '/workspace')).toBe('/data/workspaces/bob')
    expect(workspacePath('/data/workspaces/bob', '')).toBe('/data/workspaces/bob')
    expect(workspacePath('/data/workspaces/bob', '../alice/notes.md')).toBeNull()
    expect(workspacePath('/data/workspaces/bob', '/workspace/../alice')).toBeNull()
    expect(workspacePath('/data/workspaces/bob', '/etc/passwd')).toBeNull()
    expect(workspacePath('/data/workspaces/bob', '/workspaces/bob/x')).toBeNull()
  })
})

describe('LocalComputer files', () => {
  it('reads and writes inside the workspace, creating folders on the way', async () => {
    const ws = join(dir, 'ws')
    const c = createLocalComputer({ workspaceDir: ws, profileDir: join(dir, 'profile'), executablePath: '/bin/chrome', launch: fakeBrowser().launch })
    await mkdir(ws, { recursive: true })
    await c.writeFile('out/report.md', '# hi')
    expect(await readFile(join(ws, 'out/report.md'), 'utf8')).toBe('# hi')
    expect(await c.readFile('/workspace/out/report.md')).toBe('# hi')
  })

  it('refuses paths that leave the workspace, by name or through a symlink', async () => {
    const ws = join(dir, 'ws')
    await mkdir(ws, { recursive: true })
    await writeFile(join(dir, 'secret.txt'), 'top secret')
    await symlink(join(dir, 'secret.txt'), join(ws, 'link.txt'))
    await symlink(dir, join(ws, 'outside'))
    const c = createLocalComputer({ workspaceDir: ws, profileDir: join(dir, 'profile'), executablePath: '/bin/chrome', launch: fakeBrowser().launch })
    await expect(c.readFile('../secret.txt')).rejects.toThrow(/escapes workspace/)
    await expect(c.readFile('/etc/hosts')).rejects.toThrow(/escapes workspace/)
    await expect(c.readFile('link.txt')).rejects.toThrow(/escapes workspace/)
    await expect(c.writeFile('outside/new.txt', 'x')).rejects.toThrow(/escapes workspace/)
    await expect(c.writeFile('outside/deeper/new.txt', 'x')).rejects.toThrow(/escapes workspace/)
  })

  it('has no shell until the operator turns one on', async () => {
    const c = createLocalComputer({ workspaceDir: dir, profileDir: join(dir, 'profile'), executablePath: '/bin/chrome', launch: fakeBrowser().launch })
    await expect(c.shell('ls')).rejects.toThrow(/Commands are off/)
  })
})

describe('LocalComputer browser', () => {
  it('launches headless with its own profile on first use, and is a local computer', async () => {
    const { state, launch } = fakeBrowser()
    const c = createLocalComputer({ workspaceDir: dir, profileDir: join(dir, 'profile'), executablePath: '/bin/chrome', launch })
    expect(c.kind).toBe('local')
    expect(state.launches).toHaveLength(0)
    expect(await c.goto('https://example.com')).toEqual({ url: 'https://example.com', title: 'Example Domain' })
    expect(state.launches).toEqual([{ profileDir: join(dir, 'profile'), executablePath: '/bin/chrome', headless: true }])
    await c.extract()
    expect(state.launches).toHaveLength(1)
  })

  it('answers ping before launch and while open, not once the browser has gone', async () => {
    const { state, launch } = fakeBrowser()
    const c = createLocalComputer({ workspaceDir: dir, profileDir: join(dir, 'profile'), executablePath: '/bin/chrome', launch })
    expect(await c.ping()).toBe(true)
    await c.goto('https://example.com')
    expect(await c.ping()).toBe(true)
    state.open = false // Chrome crashed or was quit by hand
    expect(await c.ping()).toBe(false)
    // the next page call relaunches rather than failing forever
    await c.goto('https://example.com')
    expect(state.launches).toHaveLength(2)
    await c.dispose()
    expect(state.open).toBe(false)
  })
})

describe('createLocalBackend', () => {
  it('resolves the browser once, gives each teammate its own folder and profile, and tracks who is running', async () => {
    const { state, launch } = fakeBrowser()
    let resolved = 0
    const backend = createLocalBackend({
      dataDir: dir, launch, resolveBrowser: async () => { resolved += 1; return '/bin/chrome' },
    })
    expect(backend.kind).toBe('local')
    const bob = await backend.make('bob')
    const alice = await backend.make('alice')
    expect(resolved).toBe(1)
    expect(await backend.running()).toEqual(['bob', 'alice'])
    await bob.goto('https://example.com')
    expect(state.launches[0]).toMatchObject({ profileDir: join(dir, 'bots', 'bob', 'browser') })
    await bob.writeFile('hello.txt', 'hi')
    expect(await readFile(join(dir, 'workspaces', 'bob', 'hello.txt'), 'utf8')).toBe('hi')
    await backend.stop('bob')
    expect(await backend.running()).toEqual(['alice'])
    await alice.dispose()
    expect(await backend.running()).toEqual([])
  })

  it('does not cache a failed browser lookup', async () => {
    let attempts = 0
    const backend = createLocalBackend({
      dataDir: dir, launch: fakeBrowser().launch,
      resolveBrowser: async () => { attempts += 1; if (attempts === 1) throw new Error('download failed'); return '/bin/chrome' },
    })
    await expect(backend.make('bob')).rejects.toThrow(/download failed/)
    await expect(backend.make('bob')).resolves.toBeTruthy()
  })
})
