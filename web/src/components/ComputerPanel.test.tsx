import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ComputerInfo } from '../types'
import { ComputerPanel } from './ComputerPanel'

const running: ComputerInfo = {
  botId: 'researcher',
  running: true,
  vncUrl: 'http://127.0.0.1:53314',
  routines: [{ id: 1, name: 'Morning digest', cron: '0 9 * * *', human: 'every day at 09:00', last_run_at: null }],
}

describe('ComputerPanel', () => {
  it('embeds the live screen and lists what is scheduled', () => {
    const { container } = render(<ComputerPanel info={running} botName="Scout" onClose={() => {}} />)
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toContain('http://127.0.0.1:53314/vnc.html')
    expect(frame.getAttribute('src')).toContain('autoconnect=1')
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
})
