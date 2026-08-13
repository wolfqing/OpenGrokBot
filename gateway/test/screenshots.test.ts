import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { saveScreenshot, screenshotFilePath, workspaceDir } from '../src/screenshots.js'

const shot = { buffer: Buffer.from('PNGDATA'), width: 1280, height: 800 }

describe('saveScreenshot', () => {
  it('writes under the bot workspace and returns a servable url', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogb-'))
    const saved = await saveScreenshot(dir, 'researcher', shot, 1786530000000)
    expect(saved).toEqual({ url: '/api/screenshots/researcher/1786530000000.png', width: 1280, height: 800 })
    const onDisk = join(dir, 'workspaces', 'researcher', 'screenshots', '1786530000000.png')
    expect(readFileSync(onDisk).toString()).toBe('PNGDATA')
  })
})

describe('screenshotFilePath', () => {
  it('resolves well-formed names', () => {
    expect(screenshotFilePath('/data', 'researcher', '1786530000000.png'))
      .toBe('/data/workspaces/researcher/screenshots/1786530000000.png')
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
