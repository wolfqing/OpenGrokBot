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
    if (url.includes('/computer')) return json(opts.computer ?? {})
    return json({ error: 'unexpected' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
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
    await screen.findAllByText('Scout')
    const before = calls.filter((u) => u === '/api/conversations').length
    await act(async () => { FakeSocket.last!.emit({ type: 'hello', statuses: { researcher: 'thinking' } }) })
    await waitFor(() => expect(calls.filter((u) => u === '/api/conversations').length).toBe(before + 1))
    expect(screen.getByText(/Scout …/)).toBeInTheDocument()
  })

  it('keeps the newest line as the sidebar preview when an older card updates in place', async () => {
    mockGateway()
    render(<App />)
    await screen.findAllByText('Scout')
    const at = (id: number, kind: string, content: string, payload: unknown = null) => ({
      type: 'message', threadId: 'dm:researcher',
      message: { id, thread_id: 'dm:researcher', sender: 'researcher', kind, content, payload, created_at: id },
    })
    await act(async () => {
      FakeSocket.last!.emit(at(3, 'activity', '', { done: false, steps: [{ tool: 'shell', summary: 'ls' }] }))
      FakeSocket.last!.emit(at(4, 'text', 'All filed.'))
      FakeSocket.last!.emit(at(3, 'activity', '', { done: true, steps: [{ tool: 'shell', summary: 'ls', ok: true }] }))
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
    await screen.findAllByText('Scout')
    slow = true
    await act(async () => { FakeSocket.last!.emit({ type: 'hello', statuses: {} }) })
    await waitFor(() => expect(release).toBeTypeOf('function')) // 补拉的请求已经发出、还没回来
    await act(async () => {
      FakeSocket.last!.emit({
        type: 'message', threadId: 'dm:researcher',
        message: { id: 9, thread_id: 'dm:researcher', sender: 'researcher', kind: 'text', content: 'arrived mid-fetch', payload: null, created_at: 9 },
      })
    })
    await act(async () => { release!([]) })
    // 侧栏预览里也有这句话，所以只看线程本身
    expect(document.querySelector('.thread-scroll')!.textContent).toContain('arrived mid-fetch')
  })

  it('closes the computer panel when you switch to another teammate', async () => {
    mockGateway({
      conversations: [conversation({}), conversation({ id: 'dm:chief', title: 'Chief', members: ['chief'] })],
      computer: { botId: 'researcher', running: false, vncUrl: null, routines: [], error: 'Docker is not running.' },
    })
    render(<App />)
    await screen.findAllByText('Scout')
    await act(async () => { screen.getByRole('button', { name: 'Open its computer' }).click() })
    expect(await screen.findByText("Scout's computer")).toBeInTheDocument()
    await act(async () => { screen.getByText('Chief').click() })
    await waitFor(() => expect(document.querySelector('.computer-panel')).toBeNull())
  })
})
