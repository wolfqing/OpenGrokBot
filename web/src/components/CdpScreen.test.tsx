import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpScreen } from './CdpScreen'

/** 假的 WebSocket：记下每次连接，测试里手动喂消息、手动关 */
class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  constructor(public url: string) { FakeSocket.instances.push(this) }
  close() { this.closed = true; this.onclose?.() }
}

beforeEach(() => { FakeSocket.instances = []; vi.stubGlobal('WebSocket', FakeSocket); vi.useFakeTimers() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!

describe('CdpScreen', () => {
  it('shows frames as they arrive and reconnects with backoff when the gateway drops the stream', async () => {
    render(<CdpScreen url="/screen/researcher/ws" title="Scout's screen" />)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(last().url).toMatch(/\/screen\/researcher\/ws$/)
    expect(screen.getByRole('status')).toHaveTextContent('Connecting…')
    act(() => { last().onopen?.(); last().onmessage?.({ data: JSON.stringify({ type: 'frame', data: 'QUJD', width: 1280, height: 800 }) }) })
    expect(screen.getByRole('img', { name: "Scout's screen" }).getAttribute('src')).toBe('data:image/jpeg;base64,QUJD')
    expect(screen.queryByRole('status')).toBeNull()
    act(() => { last().onclose?.() }) // 浏览器重开：网关断了这条连接
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('stops for good when the gateway says there is no screen, and closes on unmount', () => {
    const { unmount } = render(<CdpScreen url="/screen/researcher/ws" title="Scout's screen" />)
    act(() => { last().onmessage?.({ data: JSON.stringify({ type: 'error', error: 'this computer has no screen to stream' }) }); last().onclose?.() })
    expect(screen.getByRole('status')).toHaveTextContent('no screen to stream')
    act(() => { vi.advanceTimersByTime(20000) })
    expect(FakeSocket.instances).toHaveLength(1)
    unmount()
  })

  it('does not reconnect while the tab is hidden', () => {
    render(<CdpScreen url="/screen/researcher/ws" title="Scout's screen" />)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(last().closed).toBe(true)
    act(() => { vi.advanceTimersByTime(20000) })
    expect(FakeSocket.instances).toHaveLength(1)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
