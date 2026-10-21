import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalChip } from './ApprovalChip'

const pending = { approvalId: 7, action: 'send the 4 queued drafts', detail: 'to the Globex thread', status: 'pending' as const }

describe('ApprovalChip', () => {
  it('shows the action, its detail and both buttons while pending', () => {
    render(<ApprovalChip payload={pending} onDecide={() => {}} />)
    expect(screen.getByText('send the 4 queued drafts')).toBeInTheDocument()
    expect(screen.getByText('to the Globex thread')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
  })

  it('reports the decision with the approval id', async () => {
    const onDecide = vi.fn()
    render(<ApprovalChip payload={pending} onDecide={onDecide} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onDecide).toHaveBeenCalledWith(7, 'approve')
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onDecide).toHaveBeenCalledWith(7, 'discard')
  })

  it('replaces the buttons with the outcome once decided', () => {
    const { rerender } = render(<ApprovalChip payload={{ ...pending, status: 'approved' }} onDecide={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByText('Approved')).toBeInTheDocument()
    rerender(<ApprovalChip payload={{ ...pending, status: 'discarded' }} onDecide={() => {}} />)
    expect(screen.getByText('Discarded')).toBeInTheDocument()
  })

  it('omits the detail line when there is none', () => {
    const { container } = render(<ApprovalChip payload={{ ...pending, detail: undefined }} onDecide={() => {}} />)
    expect(container.querySelector('.approval-detail')).toBeNull()
  })

  it('offers to keep allowing an email to one address, and says for how long', async () => {
    const onDecide = vi.fn()
    render(<ApprovalChip payload={{ ...pending, kind: 'email', target: 'bob@acme.com', canRemember: true }} onDecide={onDecide} />)
    expect(screen.getByText('email → bob@acme.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Always allow…' }))
    expect(screen.getByText(/stop asking about email → bob@acme.com/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '24 hours' }))
    expect(onDecide).toHaveBeenCalledWith(7, 'approve', '24h')
  })

  it('lets you back out of remembering without deciding', async () => {
    const onDecide = vi.fn()
    render(<ApprovalChip payload={{ ...pending, kind: 'post', target: '#ops', canRemember: true }} onDecide={onDecide} />)
    await userEvent.click(screen.getByRole('button', { name: 'Always allow…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onDecide).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('never offers to remember a purchase', () => {
    render(<ApprovalChip payload={{ ...pending, kind: 'purchase', target: 'amazon.com', canRemember: false }} onDecide={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Always allow…' })).toBeNull()
  })

  it('shows a hold your rule let through, with no buttons', () => {
    render(<ApprovalChip
      payload={{ ...pending, status: 'approved', kind: 'email', target: 'bob@acme.com', rule: { id: 3, kind: 'email', target: 'bob@acme.com', expiresAt: null } }}
      onDecide={() => {}}
    />)
    expect(screen.getByText('Allowed by your rule')).toBeInTheDocument()
    expect(screen.getByText(/until you revoke it/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('notes the rule you saved when you approved', () => {
    render(<ApprovalChip
      payload={{ ...pending, status: 'approved', kind: 'email', target: 'bob@acme.com', remembered: { id: 3, expiresAt: null } }}
      onDecide={() => {}}
    />)
    expect(screen.getByText('Approved · email → bob@acme.com allowed until you revoke it')).toBeInTheDocument()
  })

  it('says why a standing rule did not apply this time', () => {
    render(<ApprovalChip payload={{ ...pending, kind: 'email', target: 'bob@acme.com', canRemember: true, ruleHeld: 'webhook' }} onDecide={() => {}} />)
    expect(screen.getByText(/Your standing rule covers email → bob@acme.com, but rules only apply to work you start yourself: this came in through a webhook\./))
      .toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('says why "Always allow" is not offered for a vague destination', () => {
    render(<ApprovalChip payload={{ ...pending, kind: 'email', target: '*', canRemember: false, rememberBlocked: '"*" is a wildcard, not one destination' }} onDecide={() => {}} />)
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
    expect(screen.getByText(/No "Always allow": "\*" is a wildcard, not one destination\./)).toBeInTheDocument()
  })

  it('drops both notes once the hold is decided', () => {
    render(<ApprovalChip payload={{ ...pending, status: 'approved', kind: 'email', target: '*', ruleHeld: 'routine', rememberBlocked: 'x' }} onDecide={() => {}} />)
    expect(screen.queryByText(/standing rule covers/)).toBeNull()
    expect(screen.queryByText(/No "Always allow"/)).toBeNull()
  })
})
