import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/prompts.js'

const bot = { id: 'researcher', name: 'Scout', role: 'research briefs', emoji: '🔎', soul_path: '' }

describe('buildSystemPrompt', () => {
  it('includes name, role, soul and report grammar', () => {
    const p = buildSystemPrompt(bot, '# Scout\nYou are Scout.')
    expect(p).toContain('Scout')
    expect(p).toContain('research briefs')
    expect(p).toContain('You are Scout.')
    expect(p).toContain('message_user') // 汇报语法规范
    expect(p).toContain('"report"')
  })

  it('omits role line when empty', () => {
    const p = buildSystemPrompt({ ...bot, role: '' }, 'soul')
    expect(p).not.toContain('Your job:')
  })

  it('swaps the no-computer note for the computer briefing when one is attached', () => {
    expect(buildSystemPrompt(bot, 'soul')).toContain('no shell, browser, or file tools')
    const withComputer = buildSystemPrompt(bot, 'soul', { hasComputer: true })
    expect(withComputer).toContain('your own computer')
    expect(withComputer).toContain('browser_screenshot')
    expect(withComputer).not.toContain('no shell, browser, or file tools')
  })

  it('carries the approval discipline and standing rules', () => {
    const p = buildSystemPrompt(bot, 'soul', { memory: '- quiet accounts wait for your read' })
    expect(p).toContain('hold_for_approval')
    expect(p).toContain('Standing rules')
    expect(p).toContain('quiet accounts wait for your read')
  })

  it('omits the standing-rules block when memory is empty', () => {
    expect(buildSystemPrompt(bot, 'soul', { memory: '   ' })).not.toContain('Standing rules')
  })
})
