import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScreenshotChip } from './ScreenshotChip'

describe('ScreenshotChip', () => {
  it('renders the image with its natural aspect ratio and caption', () => {
    render(<ScreenshotChip payload={{ url: '/api/screenshots/researcher/7.png', width: 1280, height: 800, caption: 'the homepage' }} />)
    const img = screen.getByAltText('the homepage')
    expect(img).toHaveAttribute('src', '/api/screenshots/researcher/7.png')
    expect(img).toHaveAttribute('width', '1280')
    expect(img).toHaveAttribute('height', '800')
    expect(screen.getByText('the homepage')).toBeInTheDocument()
  })

  it('falls back to a generic alt and hides the caption line when absent', () => {
    const { container } = render(<ScreenshotChip payload={{ url: '/api/screenshots/researcher/8.png', width: 1280, height: 800 }} />)
    expect(screen.getByAltText("Bot's screen")).toBeInTheDocument()
    expect(container.querySelector('.shot-caption')).toBeNull()
  })
})
