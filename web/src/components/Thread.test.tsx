import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Bot, Message } from '../types'
import { Thread } from './Thread'

const bot: Bot = { id: 'researcher', name: 'Scout', role: 'research', emoji: '🔎', thread_id: 'dm:researcher', last_message: null }

const messages: Message[] = [
  { id: 1, thread_id: 'dm:researcher', sender: 'user', kind: 'text', content: 'scan the web', payload: null, created_at: 1 },
  { id: 2, thread_id: 'dm:researcher', sender: 'researcher', kind: 'report', content: '', created_at: 2,
    payload: { lines: [{ system: 'Web', result: 'scanned', count: '3 pages' }], closing: 'nothing needs you' } },
  { id: 3, thread_id: 'dm:researcher', sender: 'researcher', kind: 'text', content: 'Done.', payload: null, created_at: 3 },
]

describe('Thread', () => {
  it('renders bubbles and report chip', () => {
    render(<Thread bot={bot} messages={messages} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('scan the web')).toBeInTheDocument()
    expect(screen.getByText('Web')).toBeInTheDocument() // report chip
    expect(screen.getByText('Done.')).toBeInTheDocument()
  })

  it('renders a screenshot chip', () => {
    const withShot: Message[] = [...messages, {
      id: 4, thread_id: 'dm:researcher', sender: 'researcher', kind: 'screenshot', content: '', created_at: 4,
      payload: { url: '/api/screenshots/researcher/9.png', width: 1280, height: 800, caption: 'example.com' },
    }]
    render(<Thread bot={bot} messages={withShot} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByAltText('example.com')).toHaveAttribute('src', '/api/screenshots/researcher/9.png')
  })

  it('renders an approval chip and reports decisions', async () => {
    const onDecide = vi.fn()
    const withApproval: Message[] = [{
      id: 9, thread_id: 'dm:researcher', sender: 'researcher', kind: 'approval_request', content: '', created_at: 9,
      payload: { approvalId: 7, action: 'send the brief', status: 'pending' },
    }]
    render(<Thread bot={bot} messages={withApproval} thinking={false} onSend={() => {}} onDecide={onDecide} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onDecide).toHaveBeenCalledWith(7, 'approve')
  })

  it('centres the decision line instead of showing it as a user bubble', () => {
    const resolved: Message[] = [{
      id: 10, thread_id: 'dm:researcher', sender: 'user', kind: 'approval_resolved', content: '', created_at: 10,
      payload: { approvalId: 7, action: 'send the brief', decision: 'approve' },
    }]
    const { container } = render(<Thread bot={bot} messages={resolved} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText(/Approved/)).toBeInTheDocument()
    expect(container.querySelector('.row.centered')).toBeTruthy()
    expect(container.querySelector('.row.from-user')).toBeNull()
  })

  it('shows typing indicator while thinking', () => {
    render(<Thread bot={bot} messages={[]} thinking={true} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('•••')).toBeInTheDocument()
  })

  it('sends trimmed draft on Enter and clears input', async () => {
    const onSend = vi.fn()
    render(<Thread bot={bot} messages={[]} thinking={false} onSend={onSend} onDecide={() => {}} />)
    const input = screen.getByPlaceholderText('Message Scout')
    await userEvent.type(input, '  hello there{Enter}')
    expect(onSend).toHaveBeenCalledWith('hello there')
    expect(input).toHaveValue('')
  })
})
