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
})
