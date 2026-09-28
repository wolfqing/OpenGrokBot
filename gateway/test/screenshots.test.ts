import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { saveScreenshot, screenshotFilePath, workspaceDir } from '../src/screenshots.js'

const shot = { buffer: Buffer.from('PNGDATA'), width: 1280, height: 800 }

describe('saveScreenshot', () => {
  it('writes outside the bot workspace, where the bot cannot doctor its own evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogb-'))
    const saved = await saveScreenshot(dir, 'researcher', shot, 1786530000000)
    expect(saved).toEqual({ url: '/api/screenshots/researcher/1786530000000.png', width: 1280, height: 800 })
    const onDisk = join(dir, 'bots', 'researcher', 'screenshots', '1786530000000.png')
    expect(readFileSync(onDisk).toString()).toBe('PNGDATA')
  })
})

describe('screenshotFilePath', () => {
  it('resolves well-formed names, new location first and the old workspace one as a fallback', () => {
    expect(screenshotFilePath('/data', 'researcher', '1786530000000.png')).toEqual([
      '/data/bots/researcher/screenshots/1786530000000.png',
      '/data/workspaces/researcher/screenshots/1786530000000.png',
    ])
  })

  it('rejects traversal and non-screenshot names', () => {
    expect(screenshotFilePath('/data', 'researcher', '../../../etc/passwd')).toBeNull()
    expect(screenshotFilePath('/data', 'researcher', 'a/b.png')).toBeNull()
    expect(screenshotFilePath('/data', 'researcher', 'notes.md')).toBeNull()
    expect(screenshotFilePath('/data', '../evil', '1.png')).toBeNull()
  })
})

describe('workspaceDir', () => {
  it('is per bot under the data dir', () => {
    expect(workspaceDir('/data', 'researcher')).toBe('/data/workspaces/researcher')
  })
})
