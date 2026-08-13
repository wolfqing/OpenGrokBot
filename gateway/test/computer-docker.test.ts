import { describe, expect, it } from 'vitest'
import { createDockerComputer } from '../src/computer-docker.js'

const endpoints = { shim: 'http://127.0.0.1:7717', cdp: 'http://127.0.0.1:9222', vnc: 'http://127.0.0.1:6080' }

function fakePage(overrides: Record<string, unknown> = {}) {
  const state = { url: 'about:blank', clicked: [] as string[], goneTo: [] as string[] }
  return {
    state,
    page: {
      async goto(url: string) { state.goneTo.push(url); state.url = url },
      async title() { return 'Example Domain' },
      url: () => state.url,
      async innerText() { return 'Example Domain\nMore information...' },
      async screenshot() { return Buffer.from('PNGDATA') },
      async click(sel: string) { state.clicked.push(sel) },
      viewportSize: () => ({ width: 1280, height: 800 }),
      ...overrides,
    },
  }
}

function fakeConnect<P>(page: P) {
  let closed = false
  const browser = {
    contexts: () => [{ pages: () => [page], newPage: async () => page }],
    close: async () => { closed = true },
    get closed() { return closed },
  }
  return { browser, connect: async (_cdpUrl?: string) => browser }
}

describe('DockerComputer shell/file over shim', () => {
  it('POSTs shell to the shim and returns its result', async () => {
    let captured: { url: string; body: unknown } | null = null
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init!.body)) }
      return new Response(JSON.stringify({ stdout: 'hi\n', stderr: '', exitCode: 0 }))
    }) as typeof fetch
    const c = createDockerComputer(endpoints, { fetchImpl })
    expect(await c.shell('echo hi')).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 })
    expect(captured!.url).toBe('http://127.0.0.1:7717/shell')
    expect(captured!.body).toEqual({ cmd: 'echo hi' })
  })

  it('surfaces shim errors as thrown errors', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'path escapes workspace' }), { status: 400 })) as typeof fetch
    const c = createDockerComputer(endpoints, { fetchImpl })
    await expect(c.readFile('../etc/passwd')).rejects.toThrow(/path escapes workspace/)
  })

  it('reads and writes files through the shim', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ content: 'hello', ok: true }))
    }) as typeof fetch
    const c = createDockerComputer(endpoints, { fetchImpl })
    expect(await c.readFile('notes.md')).toBe('hello')
    await c.writeFile('notes.md', 'hello')
    expect(seen).toEqual(['http://127.0.0.1:7717/read', 'http://127.0.0.1:7717/write'])
  })
})

describe('DockerComputer browser over CDP', () => {
  it('reuses the existing page, navigates and reports title', async () => {
    const { page, state } = fakePage()
    const c = createDockerComputer(endpoints, { connect: fakeConnect(page).connect })
    expect(await c.goto('https://example.com')).toEqual({ url: 'https://example.com', title: 'Example Domain' })
    expect(state.goneTo).toEqual(['https://example.com'])
  })

  it('extracts body text and truncates', async () => {
    const { page } = fakePage()
    const c = createDockerComputer(endpoints, { connect: fakeConnect(page).connect })
    expect(await c.extract()).toContain('Example Domain')
    expect(await c.extract(7)).toBe('Example')
  })

  it('screenshots with viewport dimensions', async () => {
    const { page } = fakePage()
    const c = createDockerComputer(endpoints, { connect: fakeConnect(page).connect })
    const shot = await c.screenshot()
    expect(shot.buffer.toString()).toBe('PNGDATA')
    expect(shot).toMatchObject({ width: 1280, height: 800 })
  })

  it('clicks css selectors directly and falls back to text matching', async () => {
    const { page, state } = fakePage()
    const c = createDockerComputer(endpoints, { connect: fakeConnect(page).connect })
    expect(await c.click('#submit')).toEqual({ clicked: '#submit' })
    expect(state.clicked).toEqual(['#submit'])

    const textClicks: string[] = []
    const { page: textPage } = fakePage({
      async click() { throw new Error('no such selector') },
      getByText: (t: string) => ({ first: () => ({ click: async () => { textClicks.push(t) } }) }),
    })
    const c2 = createDockerComputer(endpoints, { connect: fakeConnect(textPage).connect })
    expect(await c2.click('Sign in')).toEqual({ clicked: 'Sign in' })
    expect(textClicks).toEqual(['Sign in'])
  })

  it('connects once and disposes the browser connection', async () => {
    let connects = 0
    const { page } = fakePage()
    const f = fakeConnect(page)
    const c = createDockerComputer(endpoints, { connect: async (u) => { connects += 1; return f.connect(u) } })
    await c.goto('https://example.com')
    await c.extract()
    expect(connects).toBe(1)
    await c.dispose()
    expect(f.browser.closed).toBe(true)
  })
})
