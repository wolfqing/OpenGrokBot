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
    render(<Thread bot={bot} messages={messages} thinking={false} onSend={() => {}} />)
    expect(screen.getByText('scan the web')).toBeInTheDocument()
    expect(screen.getByText('Web')).toBeInTheDocument() // report chip
    expect(screen.getByText('Done.')).toBeInTheDocument()
  })

  it('shows typing indicator while thinking', () => {
    render(<Thread bot={bot} messages={[]} thinking={true} onSend={() => {}} />)
    expect(screen.getByText('•••')).toBeInTheDocument()
  })

  it('sends trimmed draft on Enter and clears input', async () => {
    const onSend = vi.fn()
    render(<Thread bot={bot} messages={[]} thinking={false} onSend={onSend} />)
    const input = screen.getByPlaceholderText('Message Scout')
    await userEvent.type(input, '  hello there{Enter}')
    expect(onSend).toHaveBeenCalledWith('hello there')
    expect(input).toHaveValue('')
  })
})
