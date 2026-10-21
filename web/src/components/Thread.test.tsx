import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Conversation, Message } from '../types'
import { Thread } from './Thread'

const dm: Conversation = {
  id: 'dm:researcher', kind: 'dm', title: 'Scout', emoji: '🔎', subtitle: 'research',
  members: ['researcher'], last_message: null, pending: 0,
}
const group: Conversation = {
  id: 'group:offsite-crew', kind: 'group', title: 'Offsite crew', emoji: '👥', subtitle: 'Scout, Ticker',
  members: ['researcher', 'market-watch'], last_message: null, pending: 0,
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

  it('offers the screen button in a one-to-one thread only', async () => {
    const onOpenScreen = vi.fn()
    const { rerender } = render(
      <Thread conversation={dm} roster={roster} messages={[]} thinking={false} onSend={() => {}} onDecide={() => {}} onOpenScreen={onOpenScreen} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open its computer' }))
    expect(onOpenScreen).toHaveBeenCalled()

    rerender(
      <Thread conversation={group} roster={roster} messages={[]} thinking={false} onSend={() => {}} onDecide={() => {}} onOpenScreen={onOpenScreen} />,
    )
    expect(screen.queryByRole('button', { name: 'Open its computer' })).toBeNull()
  })

  it('renders a login request and opens the screen from it', async () => {
    const onOpenScreen = vi.fn()
    const asked: Message[] = [{
      id: 11, thread_id: 'dm:researcher', sender: 'researcher', kind: 'login_request', content: '', created_at: 11,
      payload: { site: 'Zendesk', why: 'to work the support queue' },
    }]
    render(
      <Thread conversation={dm} roster={roster} messages={asked} thinking={false} onSend={() => {}} onDecide={() => {}} onOpenScreen={onOpenScreen} />,
    )
    expect(screen.getByText('Sign in to Zendesk')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open its screen' }))
    expect(onOpenScreen).toHaveBeenCalled()
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

  it('does not send while an input method is still composing (Chinese, Japanese…)', () => {
    const onSend = vi.fn()
    render(<Thread conversation={dm} roster={roster} messages={[]} thinking={false} onSend={onSend} onDecide={() => {}} />)
    const box = screen.getByPlaceholderText('Message Scout')
    fireEvent.change(box, { target: { value: 'nihao' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 }) // Safari 在 compositionend 之后才发这个
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('nihao')
  })

  it('keeps Shift+Enter for a new line', async () => {
    const onSend = vi.fn()
    render(<Thread conversation={dm} roster={roster} messages={[]} thinking={false} onSend={onSend} onDecide={() => {}} />)
    const box = screen.getByPlaceholderText('Message Scout')
    await userEvent.type(box, 'line one{Shift>}{Enter}{/Shift}line two')
    expect(onSend).not.toHaveBeenCalled()
    expect(box).toHaveValue('line one\nline two')
  })

  it('offers a stop button while the bot is working', async () => {
    const onStop = vi.fn()
    const { rerender } = render(
      <Thread conversation={dm} roster={roster} messages={[]} thinking={false} onSend={() => {}} onDecide={() => {}} onStop={onStop} />,
    )
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    rerender(<Thread conversation={dm} roster={roster} messages={[]} thinking={true} onSend={() => {}} onDecide={() => {}} onStop={onStop} />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalled()
  })

  it('renders the steps a bot took on its computer', async () => {
    const worked: Message[] = [{
      id: 20, thread_id: 'dm:researcher', sender: 'researcher', kind: 'activity', content: '', created_at: 20,
      payload: {
        done: true,
        steps: [
          { tool: 'shell', summary: 'ls -la reports/', ok: true, ms: 120 },
          { tool: 'browser_goto', summary: 'https://nope.invalid', ok: false, ms: 900 },
        ],
      },
    }]
    render(<Thread conversation={dm} roster={roster} messages={worked} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText(/2 steps/)).toBeInTheDocument()
    expect(screen.getByText(/1 failed/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /2 steps/ }))
    expect(screen.getByText('ls -la reports/')).toBeInTheDocument()
    expect(screen.getByText('https://nope.invalid')).toBeInTheDocument()
  })

  it('shows the step in progress while the bot is still working', () => {
    const working: Message[] = [{
      id: 21, thread_id: 'dm:researcher', sender: 'researcher', kind: 'activity', content: '', created_at: 21,
      payload: { done: false, steps: [{ tool: 'browser_goto', summary: 'https://example.com' }] },
    }]
    render(<Thread conversation={dm} roster={roster} messages={working} thinking={true} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('https://example.com')).toBeInTheDocument()
  })

  it('renders a teammate reply as markdown, with safe links and no images', () => {
    const md: Message[] = [{
      id: 30, thread_id: 'dm:researcher', sender: 'researcher', kind: 'text', created_at: 30, payload: null,
      content: 'Found **two** options:\n\n- [Docs](https://example.com/docs)\n- run `pnpm dev`\n- [boom](javascript:alert(1))\n\n'
        + '![pixel](https://tracker.invalid/p.png) <b>raw html</b>',
    }]
    const { container } = render(<Thread conversation={dm} roster={roster} messages={md} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('two').tagName).toBe('STRONG')
    expect(screen.getByText('pnpm dev').tagName).toBe('CODE')
    const link = screen.getByRole('link', { name: 'Docs' })
    expect(link).toHaveAttribute('href', 'https://example.com/docs')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(container.querySelector('a[href^="javascript"]')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/pixel/)).toBeInTheDocument() // 图片只留替代文字
    expect(container.querySelector('b')).toBeNull()
    expect(screen.getByText(/raw html/).tagName).toBe('P') // 夹带的 HTML 标签被丢掉，文字保留
  })

  it('keeps a single newline as a line break, so a dispatch table stays one item per line', () => {
    const table: Message[] = [{
      id: 32, thread_id: 'group:offsite-crew', sender: 'chief', kind: 'text', payload: null, created_at: 32,
      content: '✓ Pricing → @market-watch · Friday\n✓ Brief → @researcher · Thursday\nOne thing needs you today.',
    }]
    const { container } = render(<Thread conversation={group} roster={roster} messages={table} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(container.querySelectorAll('.bubble.markdown br')).toHaveLength(2)
  })

  it("keeps the operator's own words exactly as typed", () => {
    const typed: Message[] = [{
      id: 31, thread_id: 'dm:researcher', sender: 'user', kind: 'text', content: 'use **literal** stars', payload: null, created_at: 31,
    }]
    render(<Thread conversation={dm} roster={roster} messages={typed} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('use **literal** stars')).toBeInTheDocument()
  })

  it('separates days and stamps the time again only after a pause', () => {
    const t0 = Date.UTC(2026, 2, 9, 12, 0)
    const row = (id: number, sender: string, content: string, created_at: number): Message =>
      ({ id, thread_id: 'dm:researcher', sender, kind: 'text', content, payload: null, created_at })
    const spread: Message[] = [
      row(1, 'user', 'morning', t0),
      row(2, 'researcher', 'hi', t0 + 20_000), // 20 秒后：不再标时间
      row(3, 'user', 'later', t0 + 40 * 60_000), // 停了 40 分钟：标
      row(4, 'researcher', 'next day', t0 + 26 * 3_600_000), // 换天：分隔线 + 标
    ]
    const { container } = render(<Thread conversation={dm} roster={roster} messages={spread} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(container.querySelectorAll('.day-divider')).toHaveLength(2)
    const stamped = [...container.querySelectorAll('time.row-time')].map((t) => t.getAttribute('datetime'))
    expect(stamped).toEqual([t0, t0 + 40 * 60_000, t0 + 26 * 3_600_000].map((t) => new Date(t).toISOString()))
  })

  it('calls the current day "Today"', () => {
    const fresh: Message[] = [{
      id: 1, thread_id: 'dm:researcher', sender: 'user', kind: 'text', content: 'now', payload: null, created_at: Date.now(),
    }]
    render(<Thread conversation={dm} roster={roster} messages={fresh} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('Today')).toBeInTheDocument()
  })

  it('shows a webhook call as outside data, folding a long one', async () => {
    const body = `{"issue": "${'x'.repeat(700)}"}`
    const called: Message[] = [{
      id: 40, thread_id: 'dm:researcher', sender: 'webhook', kind: 'webhook', content: '', created_at: 40,
      payload: { routineId: 2, name: 'Triage', body },
    }]
    const { container } = render(<Thread conversation={dm} roster={roster} messages={called} thinking={false} onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('Webhook · outside data')).toBeInTheDocument()
    expect(screen.getByText('Triage')).toBeInTheDocument()
    expect(container.querySelector('.webhook-body')!.textContent!.length).toBeLessThan(body.length)
    await userEvent.click(screen.getByRole('button', { name: /Show all/ }))
    expect(container.querySelector('.webhook-body')!.textContent).toBe(body)
    expect(container.querySelector('.row.from-user')).toBeNull()
  })
})
