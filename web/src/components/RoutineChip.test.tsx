import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RoutineChip } from './RoutineChip'

describe('RoutineChip', () => {
  it('shows the routine name and its schedule in plain English', () => {
    render(<RoutineChip payload={{ routineId: 3, name: 'Overnight outbound', cron: '0 9 * * *', human: 'every day at 09:00' }} />)
    expect(screen.getByText('Created routine')).toBeInTheDocument()
    expect(screen.getByText('🕐 Overnight outbound')).toBeInTheDocument()
    expect(screen.getByText('every day at 09:00')).toBeInTheDocument()
  })
})
