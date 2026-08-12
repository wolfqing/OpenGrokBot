import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReportChip } from './ReportChip'

describe('ReportChip', () => {
  it('renders ✓ system → result · count lines and closing', () => {
    render(
      <ReportChip payload={{
        lines: [
          { system: 'Salesforce', result: 'list pulled', count: '52 accounts' },
          { system: 'LinkedIn', result: 'skipped' },
        ],
        closing: 'two things need you today',
      }} />,
    )
    expect(screen.getAllByText('✓')).toHaveLength(2)
    expect(screen.getByText('Salesforce')).toBeInTheDocument()
    expect(screen.getByText(/list pulled/)).toBeInTheDocument()
    expect(screen.getByText(/· 52 accounts/)).toBeInTheDocument()
    expect(screen.getByText('two things need you today')).toBeInTheDocument()
  })

  it('omits closing block when absent', () => {
    const { container } = render(<ReportChip payload={{ lines: [{ system: 'X', result: 'ok' }] }} />)
    expect(container.querySelector('.report-closing')).toBeNull()
  })
})
