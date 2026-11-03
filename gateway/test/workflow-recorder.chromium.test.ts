import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { findBrowser } from '../src/browsers.js'
import { createWorkflowRecorder } from '../src/workflow-recorder.js'

describe('workflow recorder in Chromium', () => {
  it('captures real DOM actions without double clicks, iframe reloads, or secret values', async (context) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ogb-workflow-chromium-'))
    const html = `<!doctype html><html><body>
      <form action="/results" method="get">
        <label for="agree">Agree to terms</label><input id="agree" type="checkbox">
        <label for="q">Search</label><input id="q" name="q">
        <label for="password">Password</label><input id="password" type="password" autocomplete="current-password">
        <label for="otp">Enter the 6-digit code we sent</label><input id="otp">
        <div id="message" role="textbox" contenteditable="true"></div>
        <label for="plan">Plan</label><select id="plan" name="plan"><option value="basic">Basic</option><option value="plus">Plus</option></select>
        <button type="submit">Submit</button>
      </form>
      <a href="/popup" target="_blank">Open a popup</a>
      <iframe id="child" title="Child frame" src="/frame-start"></iframe>
    </body></html>`
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (url.pathname === '/frame-start') {
        response.end('<a href="/frame-next">Navigate iframe</a>')
      } else if (url.pathname === '/frame-next') {
        response.end('<p>Iframe destination</p>')
      } else if (url.pathname === '/popup') {
        response.end('<p>Popup destination</p>')
      } else if (url.pathname === '/results') {
        response.end('<p>Search results</p>')
      } else {
        response.end(html)
      }
    })
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

    try {
      const found = findBrowser({ dataDir, env: process.env })
      const executablePath = found?.executablePath ?? chromium.executablePath()
      if (!existsSync(executablePath)) return context.skip()
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('local test server has no TCP address')
      const baseUrl = `http://127.0.0.1:${address.port}`

      browser = await chromium.launch({ executablePath, headless: true })
      const page = await browser.newPage()
      const pathToken = `github_pat_${'a'.repeat(36)}`
      await page.goto(`${baseUrl}/reset/${pathToken}/start`, { waitUntil: 'domcontentloaded' })
      const recorder = await createWorkflowRecorder(page, 'Submit a secure search')
      const bindingVisible = await page.evaluate(`(() => {
        const name = Reflect.ownKeys(window).find((key) => typeof key === 'string'
          && key.startsWith('__opengrokbot_workflow_') && !key.startsWith('__opengrokbot_workflow_state_'));
        if (!name) return false;
        try { window[name]({ type: 'navigate', url: 'https://evil.example/landing', intent: 'INJECTED-INTENT' }); } catch {}
        return true;
      })()`)
      expect(bindingVisible).toBe(false)

      await page.getByText('Agree to terms', { exact: true }).click()
      const checkboxChecked = await page.locator('#agree').isChecked()
      await page.frameLocator('#child').getByText('Navigate iframe', { exact: true }).click()
      const popupPromise = page.waitForEvent('popup')
      await page.getByText('Open a popup', { exact: true }).click()
      const popup = await popupPromise
      await popup.waitForLoadState('domcontentloaded')
      await popup.close()
      await page.getByLabel('Password').fill('never-store-this-password')
      await page.getByLabel('Enter the 6-digit code we sent').fill('123456')
      await page.evaluate(`(() => {
        const input = document.querySelector('#q');
        input.value = 'page-forged-input';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await page.waitForTimeout(450)
      await page.getByLabel('Plan').click()
      await page.keyboard.press('ArrowDown')
      await page.getByLabel('Search').fill('OpenGrok workflow')
      await page.getByLabel('Search').press('Enter')
      await page.waitForURL((url) => url.pathname === '/results')
      await page.goto(`${baseUrl}/stop-test`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(100)
      await page.locator('#message').fill('Pending contenteditable input')
      await recorder.detach?.()
      const replacementPage = await browser.newPage()
      await recorder.reattach(replacementPage)
      const trace = await recorder.stop()

      const checkboxSteps = trace.steps.filter((step) => step.type === 'check' || step.type === 'uncheck')
      expect(checkboxSteps).toHaveLength(1)
      expect(checkboxSteps[0]?.type).toBe('check')
      expect(checkboxChecked).toBe(true)

      const password = trace.steps.find((step) => step.type === 'fill'
        && step.target.candidates.some((candidate) => 'label' in candidate && candidate.label === 'Password'))
      expect(password).toMatchObject({ value: { kind: 'redacted', reason: 'sensitive-input' } })
      expect(JSON.stringify(trace)).not.toContain('never-store-this-password')
      expect(trace.steps.some((step) => step.type === 'fill' && JSON.stringify(step).includes('123456'))).toBe(false)
      expect(JSON.stringify(trace)).not.toContain('page-forged-input')
      const message = trace.steps.find((step) => step.type === 'fill'
        && 'value' in step && step.value.kind === 'literal' && step.value.text === 'Pending contenteditable input')
      expect(message).toMatchObject({ value: { kind: 'literal', text: 'Pending contenteditable input' } })
      expect(JSON.stringify(message && 'target' in message ? message.target : null)).not.toContain('Pending contenteditable input')

      expect(trace.steps[0]).toMatchObject({ type: 'navigate', url: `${baseUrl}/reset/:redacted/start` })
      expect(trace.steps.find((step) => step.type === 'select')).toMatchObject({ value: { kind: 'literal', text: 'Plus' } })
      expect(trace.steps.find((step) => step.type === 'press' && step.key === 'Enter'))
        .toMatchObject({ expect: { url: `${baseUrl}/results?q=&plan=` } })
      expect(trace.steps.some((step) => step.type === 'click'
        && step.target.candidates.some((candidate) => 'text' in candidate && candidate.text === 'Submit'))).toBe(false)
      expect(trace.steps.some((step) => step.type === 'unrecorded-popup')).toBe(true)
      expect(trace.steps.filter((step) => step.type === 'navigate')).toHaveLength(2)
      expect(trace.steps.some((step) => step.type === 'navigate' && step.url.endsWith('/stop-test'))).toBe(true)
      expect(trace.steps.some((step) => step.type === 'navigate' && step.url.includes('/frame-next'))).toBe(false)
    } finally {
      await browser?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 180_000)
})
