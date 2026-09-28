import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Conversation } from '../types'
import { Sidebar } from './Sidebar'

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'dm:researcher', kind: 'dm', title: 'Scout', emoji: '🔎', subtitle: 'research',
  members: ['researcher'], last_message: null, pending: 0, ...over,
})

describe('Sidebar', () => {
  it('badges a conversation that has approvals waiting, whatever its last message says', () => {
    render(<Sidebar conversations={[conversation({ pending: 2 })]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.getByLabelText('2 waiting on you')).toHaveTextContent('2')
  })

  it('shows no badge when nothing is waiting', () => {
    render(<Sidebar conversations={[conversation()]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.queryByLabelText(/waiting on you/)).toBeNull()
  })

  it('previews a bot that is working on its computer', () => {
    const working = conversation({
      last_message: {
        id: 3, thread_id: 'dm:researcher', sender: 'researcher', kind: 'activity', content: '', created_at: 3,
        payload: { done: false, steps: [{ tool: 'browser_goto', summary: 'https://example.com' }] },
      },
    })
    render(<Sidebar conversations={[working]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.getByText('⚙ browser_goto https://example.com')).toBeInTheDocument()
  })
})
