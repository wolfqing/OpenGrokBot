import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { QuestionPayload } from '../types'
import { QuestionChip } from './QuestionChip'

const open: QuestionPayload = { question: 'Which reply first?', options: ['Globex', 'Initech'], multi: false, status: 'open' }

describe('QuestionChip', () => {
  it('answers with one tap and shows the pick right away', async () => {
    const onAnswer = vi.fn()
    render(<QuestionChip payload={open} onAnswer={onAnswer} />)
    expect(screen.getByText('Which reply first?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Initech' }))
    expect(onAnswer).toHaveBeenCalledWith(['Initech'])
    expect(screen.queryByRole('button')).toBeNull() // 不给第二次点的机会
    expect(screen.getByText('✓ Initech')).toBeInTheDocument()
  })

  it('collects several picks before submitting when allowed', async () => {
    const onAnswer = vi.fn()
    render(<QuestionChip payload={{ ...open, multi: true, options: ['A', 'B', 'C'] }} onAnswer={onAnswer} />)
    const submit = screen.getByRole('button', { name: 'Submit' })
    expect(submit).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'A' }))
    await userEvent.click(screen.getByRole('button', { name: 'C' }))
    expect(screen.getByRole('button', { name: 'C' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(submit)
    expect(onAnswer).toHaveBeenCalledWith(['A', 'C'])
  })

  it('shows what was picked once answered, and says so when you typed instead', () => {
    const { rerender } = render(<QuestionChip payload={{ ...open, status: 'answered', answer: ['Globex'] }} onAnswer={() => {}} />)
    expect(screen.getByText('Answered')).toBeInTheDocument()
    expect(screen.getByText('✓ Globex')).toBeInTheDocument()
    rerender(<QuestionChip payload={{ ...open, status: 'skipped' }} onAnswer={() => {}} />)
    expect(screen.getByText('Answered in chat')).toBeInTheDocument()
  })

  it('reopens the card when the answer could not be delivered', async () => {
    const onAnswer = vi.fn(async () => { throw new Error('gateway 400') })
    render(<QuestionChip payload={{ question: 'Which?', options: ['A', 'B'], multi: false, status: 'open' }} onAnswer={onAnswer} />)
    await userEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(await screen.findByRole('button', { name: 'A' })).toBeInTheDocument()
    expect(screen.queryByText('Answered')).toBeNull()
  })
})
