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

  it('says a watch routine only looks', () => {
    render(<RoutineChip payload={{ routineId: 1, name: 'Status watch', cron: '*/30 * * * *', human: 'every 30 minutes', mode: 'watch' }} />)
    expect(screen.getByText('Created watch')).toBeInTheDocument()
    expect(screen.getByText(/read-only tools/)).toBeInTheDocument()
  })

  it('points to the panel for a webhook address', () => {
    render(<RoutineChip payload={{ routineId: 2, name: 'Triage', cron: '', human: 'when its webhook is called', webhook: true }} />)
    expect(screen.getByText('Created routine')).toBeInTheDocument()
    expect(screen.getByText(/Copy its webhook address/)).toBeInTheDocument()
  })
})
