import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ComputerInfo } from '../types'
import { ComputerPanel } from './ComputerPanel'

const SCREEN = 'http://127.0.0.1:53314/vnc.html?autoconnect=1&resize=scale&reconnect=1&password=pw12345x'
const running: ComputerInfo = {
  botId: 'researcher',
  running: true,
  vncUrl: SCREEN,
  routines: [{ id: 1, name: 'Morning digest', cron: '0 9 * * *', human: 'every day at 09:00', last_run_at: null, enabled: 1 }],
  usage: { today: { prompt: 12000, completion: 345, cached: 8000, total: 12345 }, budget: 200000 },
}

describe('ComputerPanel', () => {
  it('embeds the live screen and lists what is scheduled', () => {
    const { container } = render(<ComputerPanel info={running} botName="Scout" onClose={() => {}} />)
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe(SCREEN) // 网关给的地址已带好连接参数
    expect(screen.getByText("Scout's computer")).toBeInTheDocument()
    expect(screen.getByText('Morning digest')).toBeInTheDocument()
    expect(screen.getByText('every day at 09:00')).toBeInTheDocument()
  })

  it('explains why there is no screen instead of showing a blank frame', () => {
    const { container } = render(
      <ComputerPanel
        info={{ ...running, running: false, vncUrl: null, error: 'docker daemon not running' }}
        botName="Scout"
        onClose={() => {}}
      />,
    )
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText(/docker daemon not running/)).toBeInTheDocument()
  })

  it('says so when nothing is scheduled', () => {
    render(<ComputerPanel info={{ ...running, routines: [] }} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText('No routines yet.')).toBeInTheDocument()
  })

  it('reminds the operator that passwords never go through chat', () => {
    render(<ComputerPanel info={running} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText(/never hand it a password in chat/i)).toBeInTheDocument()
  })

  it('closes', async () => {
    const onClose = vi.fn()
    render(<ComputerPanel info={running} botName="Scout" onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('runs, pauses, resumes and deletes routines', async () => {
    const onRoutine = vi.fn()
    const paused = { ...running.routines[0]!, id: 2, name: 'Old sweep', enabled: 0 }
    render(<ComputerPanel info={{ ...running, routines: [running.routines[0]!, paused] }} botName="Scout" onClose={() => {}} onRoutine={onRoutine} />)
    await userEvent.click(screen.getByRole('button', { name: 'Run Morning digest now' }))
    await userEvent.click(screen.getByRole('button', { name: 'Pause Morning digest' }))
    await userEvent.click(screen.getByRole('button', { name: 'Resume Old sweep' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete Old sweep' }))
    expect(onRoutine.mock.calls).toEqual([[1, 'run'], [1, 'pause'], [2, 'resume'], [2, 'delete']])
    expect(screen.getByText('paused')).toBeInTheDocument()
  })

  it('opens straight away while the computer is still waking, and shows how long it has waited', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<ComputerPanel info={null} botName="Scout" onClose={() => {}} />)
      expect(screen.getByRole('status')).toHaveTextContent("Starting Scout's computer…")
      expect(container.querySelector('iframe')).toBeNull()
      expect(screen.queryByText('Routines')).toBeNull()
      expect(screen.queryByText(/\ds$/)).toBeNull() // 头两秒不跳数字
      act(() => { vi.advanceTimersByTime(4_000) })
      expect(screen.getByText('4s')).toBeInTheDocument()
      expect(screen.getByText(/never hand it a password in chat/i)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows today\'s token use against the budget', () => {
    render(<ComputerPanel info={running} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText(/12,345/)).toBeInTheDocument()
    expect(screen.getByText(/200,000/)).toBeInTheDocument()
  })

  it('lists what goes out without asking, and revokes it', async () => {
    const onRevokeRule = vi.fn()
    render(<ComputerPanel
      info={{ ...running, rules: [{ id: 4, kind: 'email', target: 'bob@acme.com', expiresAt: null, createdAt: 1 }] }}
      botName="Scout"
      onClose={() => {}}
      onRevokeRule={onRevokeRule}
    />)
    expect(screen.getByText('email → bob@acme.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Stop allowing email to bob@acme.com' }))
    expect(onRevokeRule).toHaveBeenCalledWith(4)
  })

  it('says nothing goes out unasked when there are no rules', () => {
    render(<ComputerPanel info={running} botName="Scout" onClose={() => {}} />)
    expect(screen.getByText('Nothing goes out without your approval.')).toBeInTheDocument()
  })

  it('lists standing rules and forgets one by its exact text', async () => {
    const onForgetRule = vi.fn()
    render(<ComputerPanel info={{ ...running, memory: ['Never email Globex on Fridays.'] }} botName="Scout" onClose={() => {}} onForgetRule={onForgetRule} />)
    await userEvent.click(screen.getByRole('button', { name: 'Forget: Never email Globex on Fridays.' }))
    expect(onForgetRule).toHaveBeenCalledWith('Never email Globex on Fridays.')
  })

  it('copies the full webhook address only for routines that have one', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const hooked = { id: 2, name: 'Triage', cron: '', human: 'when its webhook is called', last_run_at: null, enabled: 1, webhook_path: '/hooks/routines/2?key=k3y' }
    render(<ComputerPanel info={{ ...running, routines: [...running.routines, hooked] }} botName="Scout" onClose={() => {}} />)
    expect(screen.getAllByRole('button', { name: /Copy the webhook address/ })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Copy the webhook address of Triage' }))
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/hooks/routines/2?key=k3y`)
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })
})
