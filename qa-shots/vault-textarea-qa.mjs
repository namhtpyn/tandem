// Mobile visual QA: vault value textarea + eye toggle (390x844)
import { chromium, devices } from 'playwright'
import { login } from '../e2e/helpers/login'

const base = process.env.QA_BASE_URL ?? 'http://localhost:3127'
const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, baseURL: base })
const page = await ctx.newPage()
await login(page)

await page.goto(`${base}/vault`)
await page.getByRole('button', { name: 'New secret' }).click()
await page.getByRole('textbox', { name: 'Name' }).fill('qa-textarea-secret')
await page.getByRole('textbox', { name: 'Value' }).fill('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAB2VzaC1hZ2VuAAAA\n-----END OPENSSH PRIVATE KEY-----')
await page.screenshot({ path: 'qa-shots/vt-10-masked.png' })
await page.getByRole('button', { name: 'Show value' }).click()
await page.screenshot({ path: 'qa-shots/vt-11-shown.png' })
await page.getByRole('button', { name: 'Save' }).click()
await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click().catch(() => {})
await page.screenshot({ path: 'qa-shots/vt-12-saved.png' })

await browser.close()
console.log('QA DONE')
