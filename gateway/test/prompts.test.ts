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
    expect(buildSystemPrompt(bot, 'soul', false)).toContain('no shell, browser, or file tools')
    const withComputer = buildSystemPrompt(bot, 'soul', true)
    expect(withComputer).toContain('your own computer')
    expect(withComputer).toContain('browser_screenshot')
    expect(withComputer).not.toContain('no shell, browser, or file tools')
  })
})
