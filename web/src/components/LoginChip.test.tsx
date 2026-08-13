import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LoginChip } from './LoginChip'

describe('LoginChip', () => {
  it('asks for the sign-in and offers to open the screen', async () => {
    const onOpenScreen = vi.fn()
    render(<LoginChip payload={{ site: 'Zendesk', why: 'to work the support queue' }} onOpenScreen={onOpenScreen} />)
    expect(screen.getByText('Sign in to Zendesk')).toBeInTheDocument()
    expect(screen.getByText('to work the support queue')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open its screen' }))
    expect(onOpenScreen).toHaveBeenCalled()
  })

  it('works without a reason', () => {
    const { container } = render(<LoginChip payload={{ site: 'Zendesk' }} onOpenScreen={() => {}} />)
    expect(container.querySelector('.login-why')).toBeNull()
  })
})
