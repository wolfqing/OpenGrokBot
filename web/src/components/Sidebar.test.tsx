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

  it('says which teammates are stuck or finished while you were away', () => {
    render(<Sidebar
      conversations={[conversation(), conversation({ id: 'dm:market-watch', title: 'Ticker', members: ['market-watch'] })]}
      selectedId={null}
      statuses={{ researcher: 'blocked', 'market-watch': 'done' }}
      onSelect={() => {}}
      onNewBot={() => {}}
    />)
    expect(screen.getByText('stuck')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
  })

  it('lets the badge speak for a wait it already counts, and labels one it does not', () => {
    const { rerender } = render(<Sidebar conversations={[conversation({ pending: 1 })]} selectedId={null} statuses={{ researcher: 'waiting' }} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.queryByText('needs you')).toBeNull()
    rerender(<Sidebar conversations={[conversation()]} selectedId={null} statuses={{ researcher: 'waiting' }} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.getByText('needs you')).toBeInTheDocument()
  })

  it('only says a group is busy; who is stuck or waiting shows on their own row', () => {
    const group = conversation({ id: 'group:crew', kind: 'group', title: 'Crew', members: ['researcher', 'chief'] })
    const { container, rerender } = render(<Sidebar conversations={[group]} selectedId={null} statuses={{ researcher: 'thinking', chief: 'blocked' }} onSelect={() => {}} onNewBot={() => {}} />)
    expect(container.querySelector('.avatar')).toHaveAttribute('data-state', 'thinking')
    rerender(<Sidebar conversations={[group]} selectedId={null} statuses={{ researcher: 'waiting', chief: 'blocked' }} onSelect={() => {}} onNewBot={() => {}} />)
    expect(container.querySelector('.avatar')).toHaveAttribute('data-state', 'idle')
    expect(screen.queryByText('stuck')).toBeNull()
  })

  it('previews an open question', () => {
    render(<Sidebar
      conversations={[conversation({
        last_message: {
          id: 4, thread_id: 'dm:researcher', sender: 'researcher', kind: 'question', content: '', created_at: 4,
          payload: { question: 'Which reply first?', options: ['A', 'B'], multi: false, status: 'open' },
        },
      })]}
      selectedId={null}
      statuses={{}}
      onSelect={() => {}}
      onNewBot={() => {}}
    />)
    expect(screen.getByText('❓ Which reply first?')).toBeInTheDocument()
  })

  it('previews a webhook call as such', () => {
    const called = conversation({
      last_message: {
        id: 9, thread_id: 'dm:researcher', sender: 'webhook', kind: 'webhook', content: '', created_at: 9,
        payload: { routineId: 2, name: 'Triage', body: '{}' },
      },
    })
    render(<Sidebar conversations={[called]} selectedId={null} statuses={{}} onSelect={() => {}} onNewBot={() => {}} />)
    expect(screen.getByText('⇣ Webhook: Triage')).toBeInTheDocument()
  })
})
