import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BotRefChip } from './BotRefChip'

describe('BotRefChip', () => {
  it('names the teammate and shows what they sent', () => {
    render(<BotRefChip payload={{ from: 'chief', fromName: 'Chief', content: 'price the tiers by Friday' }} />)
    expect(screen.getByText('Messages from @Chief')).toBeInTheDocument()
    expect(screen.getByText('price the tiers by Friday')).toBeInTheDocument()
  })
})
