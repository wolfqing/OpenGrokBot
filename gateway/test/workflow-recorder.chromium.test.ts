import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { browsersDir, findBrowser, installBrowser } from '../src/browsers.js'
import { createWorkflowRecorder } from '../src/workflow-recorder.js'

describe('workflow recorder in Chromium', () => {
  it('captures real DOM actions without double clicks, iframe reloads, or secret values', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ogb-workflow-chromium-'))
    const html = `<!doctype html><html><body>
      <form action="/results" method="get">
        <label for="agree">Agree to terms</label><input id="agree" type="checkbox">
        <label for="q">Search</label><input id="q" name="q">
        <label for="password">Password</label><input id="password" type="password" autocomplete="current-password">
        <label for="plan">Plan</label><select id="plan" name="plan"><option value="basic">Basic</option><option value="plus">Plus</option></select>
        <button type="submit">Submit</button>
      </form>
      <iframe id="child" title="Child frame" src="/frame-start"></iframe>
    </body></html>`
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (url.pathname === '/frame-start') {
        response.end('<a href="/frame-next">Navigate iframe</a>')
      } else if (url.pathname === '/frame-next') {
        response.end('<p>Iframe destination</p>')
      } else if (url.pathname === '/results') {
        response.end('<p>Search results</p>')
      } else {
        response.end(html)
      }
    })
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('local test server has no TCP address')
      const baseUrl = `http://127.0.0.1:${address.port}`

      // Match smoke:local's browser discovery and fallback download through playwright-core.
      const found = findBrowser({ dataDir, env: process.env })
      const executablePath = found?.executablePath ?? await installBrowser(browsersDir(dataDir))
      browser = await chromium.launch({ executablePath, headless: true })
      const page = await browser.newPage()
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      const recorder = await createWorkflowRecorder(page, 'Submit a secure search')

      await page.getByText('Agree to terms', { exact: true }).click()
      const checkboxChecked = await page.locator('#agree').isChecked()
      await page.frameLocator('#child').getByText('Navigate iframe', { exact: true }).click()
      await page.getByLabel('Password').fill('never-store-this-password')
      await page.getByLabel('Plan').selectOption('plus')
      await page.getByLabel('Search').fill('OpenGrok workflow')
      await page.getByLabel('Search').press('Enter')
      await page.waitForURL((url) => url.pathname === '/results')
      await page.waitForTimeout(150)
      const trace = await recorder.stop()

      const checkboxSteps = trace.steps.filter((step) => step.type === 'check' || step.type === 'uncheck')
      expect(checkboxSteps).toHaveLength(1)
      expect(checkboxSteps[0]?.type).toBe('check')
      expect(checkboxChecked).toBe(true)

      const password = trace.steps.find((step) => step.type === 'fill'
        && step.target.candidates.some((candidate) => 'label' in candidate && candidate.label === 'Password'))
      expect(password).toMatchObject({ value: { kind: 'redacted', reason: 'sensitive-input' } })
      expect(JSON.stringify(trace)).not.toContain('never-store-this-password')

      expect(trace.steps.find((step) => step.type === 'select')).toMatchObject({ value: { kind: 'literal', text: 'Plus' } })
      expect(trace.steps.some((step) => step.type === 'press' && step.key === 'Enter')).toBe(true)
      expect(trace.steps.filter((step) => step.type === 'navigate')).toHaveLength(1)
      expect(trace.steps.some((step) => step.type !== 'navigate' && step.type !== 'unrecorded-popup'
        && step.expect?.url === `${baseUrl}/results?q=&plan=`)).toBe(true)
      expect(trace.steps.some((step) => step.type === 'navigate' && step.url.includes('/frame-next'))).toBe(false)
    } finally {
      await browser?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 180_000)
})
