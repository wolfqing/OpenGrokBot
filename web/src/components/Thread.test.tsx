import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Conversation, Message } from '../types'
import { Thread } from './Thread'

const dm: Conversation = {
  id: 'dm:researcher', kind: 'dm', title: 'Scout', emoji: '🔎', subtitle: 'research',
  members: ['researcher'], last_message: null,
}
const group: Conversation = {
  id: 'group:offsite-crew', kind: 'group', title: 'Offsite crew', emoji: '👥', subtitle: 'Scout, Ticker',
  members: ['researcher', 'market-watch'], last_message: null,
}
const roster = {
  researcher: { name: 'Scout', emoji: '🔎' },
  'market-watch': { name: 'Ticker', emoji: '📈' },
}

const messages: Message[] = [
  { id: 1, thread_id: 'dm:researcher', sender: 'user', kind: 'text', content: 'scan the web', payload: null, created_at: 1 },
  { id: 2, thread_id: 'dm:researcher', sender: 'researcher', kind: 'report', content: '', created_at: 2,
    payload: { lines: [{ system: 'Web', result: 'scanned', count: '3 pages' }], closing: 'nothing needs you' } },
  { id: 3, thread_id: 'dm:researcher', sender: 'researcher', kind: 'text', content: 'Done.', payload: null, created_at: 3 },
]

describe('Thread', () => {
  it('renders bubbles and report chip', () => {
    render(<Thread conversation={dm} roster={roster} messages={messages} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('scan the web')).toBeInTheDocument()
    expect(screen.getByText('Web')).toBeInTheDocument() // report chip
    expect(screen.getByText('Done.')).toBeInTheDocument()
  })

  it('renders a screenshot chip', () => {
    const withShot: Message[] = [...messages, {
      id: 4, thread_id: 'dm:researcher', sender: 'researcher', kind: 'screenshot', content: '', created_at: 4,
      payload: { url: '/api/screenshots/researcher/9.png', width: 1280, height: 800, caption: 'example.com' },
    }]
    render(<Thread conversation={dm} roster={roster} messages={withShot} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByAltText('example.com')).toHaveAttribute('src', '/api/screenshots/researcher/9.png')
  })

  it('renders an approval chip and reports decisions', async () => {
    const onDecide = vi.fn()
    const withApproval: Message[] = [{
      id: 9, thread_id: 'dm:researcher', sender: 'researcher', kind: 'approval_request', content: '', created_at: 9,
      payload: { approvalId: 7, action: 'send the brief', status: 'pending' },
    }]
    render(<Thread conversation={dm} roster={roster} messages={withApproval} thinking={false} onSend={() => {}} onDecide={onDecide} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onDecide).toHaveBeenCalledWith(7, 'approve')
  })

  it('centres the decision line instead of showing it as a user bubble', () => {
    const resolved: Message[] = [{
      id: 10, thread_id: 'dm:researcher', sender: 'user', kind: 'approval_resolved', content: '', created_at: 10,
      payload: { approvalId: 7, action: 'send the brief', decision: 'approve' },
    }]
    const { container } = render(<Thread conversation={dm} roster={roster} messages={resolved} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText(/Approved/)).toBeInTheDocument()
    expect(container.querySelector('.row.centered')).toBeTruthy()
    expect(container.querySelector('.row.from-user')).toBeNull()
  })

  it('labels each speaker in a group thread', () => {
    const groupMessages: Message[] = [
      { id: 1, thread_id: 'group:offsite-crew', sender: 'user', kind: 'text', content: 'where are we?', payload: null, created_at: 1 },
      { id: 2, thread_id: 'group:offsite-crew', sender: 'researcher', kind: 'text', content: 'brief is done', payload: null, created_at: 2 },
      { id: 3, thread_id: 'group:offsite-crew', sender: 'market-watch', kind: 'text', content: 'markets are flat', payload: null, created_at: 3 },
    ]
    render(<Thread conversation={group} roster={roster} messages={groupMessages} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('Scout')).toBeInTheDocument()
    expect(screen.getByText('Ticker')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Message Offsite crew')).toBeInTheDocument()
  })

  it('does not label the speaker in a one-to-one thread', () => {
    const { container } = render(
      <Thread conversation={dm} roster={roster} messages={messages} thinking={false} onSend={() => {}} onDecide={() => {}} />,
    )
    expect(container.querySelector('.speaker')).toBeNull()
  })

  it('renders a teammate relay chip', () => {
    const relayed: Message[] = [{
      id: 4, thread_id: 'dm:market-watch', sender: 'chief', kind: 'bot_ref', content: '', created_at: 4,
      payload: { from: 'chief', fromName: 'Chief', content: 'price the tiers by Friday' },
    }]
    render(<Thread conversation={dm} roster={roster} messages={relayed} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('Messages from @Chief')).toBeInTheDocument()
  })

  it('shows typing indicator while thinking', () => {
    render(<Thread conversation={dm} roster={roster} messages={[]} thinking={true} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('•••')).toBeInTheDocument()
  })

  it('sends trimmed draft on Enter and clears input', async () => {
    const onSend = vi.fn()
    render(<Thread conversation={dm} roster={roster} messages={[]} thinking={false} onSend={onSend} onDecide={() => {}} />)
    const input = screen.getByPlaceholderText('Message Scout')
    await userEvent.type(input, '  hello there{Enter}')
    expect(onSend).toHaveBeenCalledWith('hello there')
    expect(input).toHaveValue('')
  })
})
