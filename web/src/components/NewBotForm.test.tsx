import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { NewBotForm } from './NewBotForm'

describe('NewBotForm', () => {
  it('hires with a name and one line of job description', async () => {
    const onCreate = vi.fn()
    render(<NewBotForm onCreate={onCreate} onCancel={() => {}} />)
    await userEvent.type(screen.getByPlaceholderText('Name'), 'Talent Scout')
    await userEvent.type(screen.getByPlaceholderText('What do they do?'), 'Finds and screens candidates')
    await userEvent.click(screen.getByRole('button', { name: 'Hire' }))
    expect(onCreate).toHaveBeenCalledWith('Talent Scout', 'Finds and screens candidates')
  })

  it('will not hire a nameless teammate', async () => {
    render(<NewBotForm onCreate={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: 'Hire' })).toBeDisabled()
    await userEvent.type(screen.getByPlaceholderText('Name'), '   ')
    expect(screen.getByRole('button', { name: 'Hire' })).toBeDisabled()
  })

  it('cancels', async () => {
    const onCancel = vi.fn()
    render(<NewBotForm onCreate={() => {}} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
