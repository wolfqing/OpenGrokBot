import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { Conversation } from './types'

class FakeSocket {
  static last: FakeSocket | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) { FakeSocket.last = this }
  close() {}
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }) }
}

const conversation = (over: Partial<Conversation>): Conversation => ({
  id: 'dm:researcher', kind: 'dm', title: 'Scout', emoji: '🔎', subtitle: 'research',
  members: ['researcher'], last_message: null, pending: 0, ...over,
})

function mockGateway(opts: {
  session?: number
  conversations?: Conversation[]
  messages?: (url: string) => Promise<unknown> | unknown
  computer?: unknown
  /** 不为空时，/computer 的响应等它兑现了才回（模拟电脑在醒） */
  computerGate?: Promise<void>
} = {}) {
  const calls: string[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url === '/api/session') return json({ ok: opts.session === undefined }, opts.session ?? 200)
    if (url === '/api/conversations') return json(opts.conversations ?? [conversation({})])
    if (url === '/api/bots') return json([])
    if (url.startsWith('/api/threads/')) return json(opts.messages ? await opts.messages(url) : [])
    if (url.includes('/computer')) {
      await opts.computerGate
      return json(opts.computer ?? {})
    }
    return json({ error: 'unexpected' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

/**
 * 首屏画出来了还不算准备好：连 WebSocket、换线程时收面板，都是 React 在渲染之后才跑的 effect。
 * 机器一忙，测试就会在「画出来了」和「effect 跑完了」之间的空当里动手：socket 还是 null，
 * 或者刚打开的面板被一个迟到的「换线程就收面板」关掉。等 socket 建好、把排着的 effect 冲掉，再开始操作。
 */
async function ready(): Promise<FakeSocket> {
  await screen.findAllByText('Scout')
  await waitFor(() => expect(FakeSocket.last).not.toBeNull())
  await act(async () => {})
  return FakeSocket.last!
}

beforeEach(() => {
  FakeSocket.last = null
  vi.stubGlobal('WebSocket', FakeSocket)
  document.title = 'OpenGrokBot'
})
afterEach(() => { vi.unstubAllGlobals() })

describe('App', () => {
  it('asks the operator to sign in when the gateway is locked', async () => {
    mockGateway({ session: 401 })
    render(<App />)
    expect(await screen.findByText(/sign-in link/i)).toBeInTheDocument()
  })

  it('counts what is waiting on you in the tab title', async () => {
    mockGateway({
      conversations: [
        conversation({ pending: 2 }),
        conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'], pending: 1 }),
      ],
    })
    render(<App />)
    await waitFor(() => expect(document.title).toBe('(3) OpenGrokBot'))
  })

  it('catches up after the live connection comes back', async () => {
    const calls = mockGateway()
    render(<App />)
    const socket = await ready()
    const before = calls.filter((u) => u === '/api/conversations').length
    await act(async () => { socket.emit({ type: 'hello', statuses: { researcher: 'thinking' } }) })
    await waitFor(() => expect(calls.filter((u) => u === '/api/conversations').length).toBe(before + 1))
    expect(screen.getByText(/Scout …/)).toBeInTheDocument()
  })

  it('keeps the newest line as the sidebar preview when an older card updates in place', async () => {
    mockGateway()
    render(<App />)
    const socket = await ready()
    const at = (id: number, kind: string, content: string, payload: unknown = null) => ({
      type: 'message', threadId: 'dm:researcher',
      message: { id, thread_id: 'dm:researcher', sender: 'researcher', kind, content, payload, created_at: id },
    })
    await act(async () => {
      socket.emit(at(3, 'activity', '', { done: false, steps: [{ tool: 'shell', summary: 'ls' }] }))
      socket.emit(at(4, 'text', 'All filed.'))
      socket.emit(at(3, 'activity', '', { done: true, steps: [{ tool: 'shell', summary: 'ls', ok: true }] }))
    })
    expect(screen.getAllByText('All filed.').length).toBeGreaterThan(0)
    expect(document.querySelector('.sidebar-preview')!.textContent).toBe('All filed.')
  })

  it('does not lock itself when the gateway is only restarting (dev proxy answers 502)', async () => {
    mockGateway({ session: 502 })
    render(<App />)
    await waitFor(() => expect(FakeSocket.last).not.toBeNull())
    expect(screen.queryByText(/sign-in link/i)).toBeNull()
  })

  it('keeps live updates that land while a catch-up fetch is in flight', async () => {
    let release: ((rows: unknown) => void) | undefined
    let slow = false
    mockGateway({
      messages: () => (slow ? new Promise((r) => { release = r }) : []),
    })
    render(<App />)
    const socket = await ready()
    slow = true
    await act(async () => { socket.emit({ type: 'hello', statuses: {} }) })
    await waitFor(() => expect(release).toBeTypeOf('function')) // 补拉的请求已经发出、还没回来
    await act(async () => {
      socket.emit({
        type: 'message', threadId: 'dm:researcher',
        message: { id: 9, thread_id: 'dm:researcher', sender: 'researcher', kind: 'text', content: 'arrived mid-fetch', payload: null, created_at: 9 },
      })
    })
    await act(async () => { release!([]) })
    // 侧栏预览里也有这句话，所以只看线程本身；合并发生在 fetch 的 then 里，要等它落到 DOM
    await waitFor(() => expect(document.querySelector('.thread-scroll')!.textContent).toContain('arrived mid-fetch'))
  })

  it('opens the computer panel at once and fills it in when the computer is up', async () => {
    let wake!: () => void
    mockGateway({
      computerGate: new Promise<void>((r) => { wake = r }),
      computer: { botId: 'researcher', running: false, vncUrl: null, routines: [], error: 'Docker is not running.' },
    })
    render(<App />)
    await ready()
    await act(async () => { screen.getByRole('button', { name: 'Open its computer' }).click() })
    expect(await screen.findByRole('status')).toHaveTextContent("Starting Scout's computer…")
    await act(async () => { wake() })
    expect(await screen.findByText('Docker is not running.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not reopen a panel whose computer woke up after you moved on', async () => {
    let wake!: () => void
    mockGateway({
      conversations: [conversation({}), conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'] })],
      computerGate: new Promise<void>((r) => { wake = r }),
      computer: { botId: 'researcher', running: false, vncUrl: null, routines: [], error: 'late answer' },
    })
    render(<App />)
    await ready()
    await act(async () => { screen.getByRole('button', { name: 'Open its computer' }).click() })
    expect(document.querySelector('.computer-panel')).not.toBeNull()
    await act(async () => { screen.getByText('Chief').click() })
    await waitFor(() => expect(document.querySelector('.computer-panel')).toBeNull())
    await act(async () => { wake() })
    expect(document.querySelector('.computer-panel')).toBeNull()
    expect(screen.queryByText('late answer')).toBeNull()
  })

  it('closes the computer panel when you switch to another teammate', async () => {
    mockGateway({
      conversations: [conversation({}), conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'] })],
      computer: { botId: 'researcher', running: false, vncUrl: null, routines: [], error: 'Docker is not running.' },
    })
    render(<App />)
    await ready()
    await act(async () => { screen.getByRole('button', { name: 'Open its computer' }).click() })
    expect(await screen.findByText("Scout's computer")).toBeInTheDocument()
    await act(async () => { screen.getByText('Chief').click() })
    await waitFor(() => expect(document.querySelector('.computer-panel')).toBeNull())
  })

  it('keeps a live reply that lands while two thread loads overlap', async () => {
    const gates: Record<string, (rows: unknown) => void> = {}
    let slow = false
    mockGateway({
      conversations: [conversation({}), conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'] })],
      messages: (url) => (slow ? new Promise((r) => { gates[decodeURIComponent(url)] = r }) : []),
    })
    render(<App />)
    await screen.findAllByText('Scout')
    slow = true
    await act(async () => { screen.getByText('Chief').click() }) // load(chief) 在飞
    await act(async () => { screen.getAllByText('Scout')[0]!.click() }) // 马上切回：load(scout) 在飞
    await waitFor(() => expect(gates['/api/threads/dm:chief/messages']).toBeTypeOf('function'))
    await waitFor(() => expect(gates['/api/threads/dm:researcher/messages']).toBeTypeOf('function'))
    await act(async () => { gates['/api/threads/dm:chief/messages']!([]) }) // 晚到的 chief 结果被丢掉，但不能把 scout 的记账清掉
    await act(async () => {
      FakeSocket.last!.emit({
        type: 'message', threadId: 'dm:researcher',
        message: { id: 9, thread_id: 'dm:researcher', sender: 'researcher', kind: 'text', content: 'final reply', payload: null, created_at: 9 },
      })
    })
    await act(async () => { gates['/api/threads/dm:researcher/messages']!([]) })
    await waitFor(() => expect(document.querySelector('.thread-scroll')!.textContent).toContain('final reply'))
  })
})
