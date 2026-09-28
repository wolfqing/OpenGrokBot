import { describe, expect, it } from 'vitest'
import { createDockerComputer, resolveCdpWsUrl } from '../src/computer-docker.js'

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

describe('resolveCdpWsUrl', () => {
  it('rewrites the container-reported ws host to the host-mapped port', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://127.0.0.1:53313/json/version')
      return new Response(JSON.stringify({
        Browser: 'Chrome/151.0.7922.108',
        webSocketDebuggerUrl: 'ws://0.0.0.0:9222/devtools/browser/abc-123',
      }))
    }) as typeof fetch
    expect(await resolveCdpWsUrl('http://127.0.0.1:53313', fetchImpl))
      .toBe('ws://127.0.0.1:53313/devtools/browser/abc-123')
  })

  it('throws readable errors when the endpoint is not a devtools server', async () => {
    const notOk = (async () => new Response('nope', { status: 502 })) as typeof fetch
    await expect(resolveCdpWsUrl('http://127.0.0.1:1', notOk)).rejects.toThrow(/502/)

    const noWs = (async () => new Response(JSON.stringify({ Browser: 'Chrome' }))) as typeof fetch
    await expect(resolveCdpWsUrl('http://127.0.0.1:1', noWs)).rejects.toThrow(/webSocketDebuggerUrl/)
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
    expect(await c.click('#submit')).toMatchObject({ clicked: '#submit' })
    expect(state.clicked).toEqual(['#submit'])

    const textClicks: string[] = []
    const { page: textPage } = fakePage({
      async click() { throw new Error('no such selector') },
      getByText: (t: string) => ({ first: () => ({ click: async () => { textClicks.push(t) } }) }),
    })
    const c2 = createDockerComputer(endpoints, { connect: fakeConnect(textPage).connect })
    expect(await c2.click('Sign in')).toMatchObject({ clicked: 'Sign in' })
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

describe('screen address', () => {
  it('gives the panel a noVNC page that connects, scales and signs in by itself', () => {
    const c = createDockerComputer({ ...endpoints, vncPassword: 'pw12345x' })
    expect(c.vncUrl).toBe('http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale&reconnect=1&password=pw12345x')
  })
})

describe('shim token', () => {
  it('sends the container secret with every shim call', async () => {
    let header: string | null = null
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      header = new Headers(init?.headers).get('x-shim-token')
      return new Response(JSON.stringify({ stdout: '', stderr: '', exitCode: 0 }))
    }) as typeof fetch
    await createDockerComputer({ ...endpoints, shimToken: 'tok-123' }, { fetchImpl }).shell('true')
    expect(header).toBe('tok-123')
  })
})

describe('ping', () => {
  it('is true while the shim answers and false once it does not', async () => {
    const ok = (async () => new Response(JSON.stringify({ ok: true }))) as typeof fetch
    expect(await createDockerComputer(endpoints, { fetchImpl: ok }).ping()).toBe(true)

    const refused = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    expect(await createDockerComputer(endpoints, { fetchImpl: refused }).ping()).toBe(false)

    const broken = (async () => new Response('nope', { status: 502 })) as typeof fetch
    expect(await createDockerComputer(endpoints, { fetchImpl: broken }).ping()).toBe(false)
  })

  it('is false when the shim answers but the browser does not', async () => {
    const browserDown = (async (url: string | URL | Request) => {
      if (String(url).includes('9222')) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ ok: true }))
    }) as typeof fetch
    expect(await createDockerComputer(endpoints, { fetchImpl: browserDown }).ping()).toBe(false)
  })
})

describe('DockerComputer browser connection recovery', () => {
  it('tries the CDP connection again after a failed first attempt', async () => {
    const { page } = fakePage()
    const { browser } = fakeConnect(page)
    let attempts = 0
    const c = createDockerComputer(endpoints, {
      connect: async () => {
        attempts++
        if (attempts === 1) throw new Error('ECONNREFUSED')
        return browser
      },
    })
    await expect(c.goto('https://example.com')).rejects.toThrow(/ECONNREFUSED/)
    await expect(c.goto('https://example.com')).resolves.toMatchObject({ url: 'https://example.com' })
    expect(attempts).toBe(2)
  })

  it('reconnects once the browser has gone away (chromium restarted)', async () => {
    const { page } = fakePage()
    let connected = true
    let attempts = 0
    const browser = {
      contexts: () => [{ pages: () => [page], newPage: async () => page }],
      close: async () => {},
      isConnected: () => connected,
    }
    const c = createDockerComputer(endpoints, { connect: async () => { attempts++; connected = true; return browser } })
    await c.goto('https://a.example')
    connected = false
    await c.goto('https://b.example')
    expect(attempts).toBe(2)
  })
})

describe('DockerComputer typing, keys, scrolling and tabs', () => {
  function richPage(overrides: Record<string, unknown> = {}) {
    const log: string[] = []
    const page = {
      async goto(url: string) { log.push(`goto:${url}`) },
      async title() { return 'Results' },
      url: () => 'https://example.com/results',
      async innerText() { return 'body' },
      async screenshot() { return Buffer.from('PNG') },
      async click(sel: string) { log.push(`click:${sel}`) },
      async fill(sel: string, text: string) { log.push(`fill:${sel}=${text}`) },
      getByLabel: (t: string) => ({ first: () => ({ fill: async (text: string) => { log.push(`label:${t}=${text}`) } }) }),
      getByPlaceholder: (t: string) => ({ first: () => ({ fill: async (text: string) => { log.push(`placeholder:${t}=${text}`) } }) }),
      keyboard: { press: async (key: string) => { log.push(`key:${key}`) } },
      mouse: { wheel: async (_x: number, y: number) => { log.push(`wheel:${y}`) } },
      async goBack() { log.push('back') },
      async waitForLoadState() {},
      async evaluate() { return [{ text: 'Pricing', href: 'https://example.com/pricing' }] },
      viewportSize: () => ({ width: 1280, height: 800 }),
      ...overrides,
    }
    return { page, log }
  }

  it('types into a field by selector and presses Enter to submit', async () => {
    const { page, log } = richPage()
    const c = createDockerComputer(endpoints, { connect: fakeConnect(page).connect })
    await c.type('input[name=q]', 'grok bot', true)
    expect(log).toEqual(['fill:input[name=q]=grok bot', 'key:Enter'])
  })

  it('falls back to the label, then the placeholder, when the target is not a selector', async () => {
    const { page, log } = richPage({
      async fill() { throw new Error('not a selector') },
      getByLabel: () => ({ first: () => ({ fill: async () => { throw new Error('no label') } }) }),
    })
    const c = createDockerComputer(endpoints, { connect: fakeConnect(page).connect })
    await c.type('Search the docs', 'cdp')
    expect(log).toEqual(['placeholder:Search the docs=cdp'])
  })

  it('presses keys, scrolls a screen at a time and goes back', async () => {
    const { page, log } = richPage()
    const c = createDockerComputer(endpoints, { connect: fakeConnect(page).connect })
    await c.press('Escape')
    await c.scroll('down')
    await c.scroll('up')
    expect(await c.back()).toEqual({ url: 'https://example.com/results', title: 'Results' })
    expect(log).toEqual(['key:Escape', 'wheel:700', 'wheel:-700', 'back'])
  })

  it('lists the links on the page', async () => {
    const { page } = richPage()
    const c = createDockerComputer(endpoints, { connect: fakeConnect(page).connect })
    expect(await c.links()).toEqual([{ text: 'Pricing', href: 'https://example.com/pricing' }])
  })

  it('says where a click landed', async () => {
    const { page } = richPage()
    const c = createDockerComputer(endpoints, { connect: fakeConnect(page).connect })
    expect(await c.click('#go')).toEqual({ clicked: '#go', url: 'https://example.com/results', title: 'Results' })
  })

  it('follows the newest tab, where a click that opened one left the user', async () => {
    const old = richPage({ url: () => 'https://old.example' })
    const fresh = richPage({ url: () => 'https://new.example' })
    const browser = {
      contexts: () => [{ pages: () => [old.page, fresh.page], newPage: async () => fresh.page }],
      close: async () => {},
    }
    const c = createDockerComputer(endpoints, { connect: async () => browser })
    await c.goto('https://x.example')
    expect(fresh.log).toEqual(['goto:https://x.example'])
    expect(old.log).toEqual([])
  })
})
