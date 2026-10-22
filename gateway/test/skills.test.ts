import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSkills, readSkill, skillsDir } from '../src/skills.js'

function withSkills(files: Record<string, string>): string {
  const dir = skillsDir(mkdtempSync(join(tmpdir(), 'ogb-skills-')))
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

describe('shared skills', () => {
  it('lists skills by file name, described by frontmatter or the first line of text', async () => {
    const dir = withSkills({
      'weekly-report.md': '---\ndescription: "How the Friday report is laid out"\n---\n# Weekly report\n\nSteps…',
      'triage.md': '# Triage\n\nSort inbound mail into reply, forward, ignore.\n',
      'notes.txt': 'not a skill',
      'Bad Name.md': 'ignored',
    })
    expect(await listSkills(dir)).toEqual([
      { name: 'triage', description: 'Sort inbound mail into reply, forward, ignore.' },
      { name: 'weekly-report', description: 'How the Friday report is laid out' },
    ])
  })

  it('has no skills when the folder does not exist', async () => {
    expect(await listSkills(join(tmpdir(), 'ogb-no-such-folder', 'skills'))).toEqual([])
  })

  it('reads a skill without its frontmatter, and nothing outside the list', async () => {
    const dir = withSkills({ 'triage.md': '---\ndescription: x\n---\n# Triage\n\nBody.\n' })
    writeFileSync(join(dir, '..', 'secret.md'), 'do not read')
    expect(await readSkill(dir, 'Triage')).toBe('# Triage\n\nBody.')
    expect(await readSkill(dir, 'triage.md')).toBe('# Triage\n\nBody.')
    expect(await readSkill(dir, '../secret')).toBeNull()
    expect(await readSkill(dir, 'missing')).toBeNull()
  })
})
