import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryChip } from './MemoryChip'

describe('MemoryChip', () => {
  it('announces the update and shows the rule and diff', () => {
    render(<MemoryChip payload={{ rule: 'quiet accounts wait for your read', diff: '+ - quiet accounts wait for your read', total: 3 }} />)
    expect(screen.getByText('Memory updated')).toBeInTheDocument()
    expect(screen.getByText('quiet accounts wait for your read')).toBeInTheDocument()
    expect(screen.getByText('+ - quiet accounts wait for your read')).toBeInTheDocument()
    expect(screen.getByText('3 rules on file')).toBeInTheDocument()
  })

  it('says "1 rule on file" in the singular', () => {
    render(<MemoryChip payload={{ rule: 'r', diff: '+ - r', total: 1 }} />)
    expect(screen.getByText('1 rule on file')).toBeInTheDocument()
  })
})
