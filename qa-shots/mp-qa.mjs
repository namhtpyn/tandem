// mobile QA: model providers card + agent editor at 390x844 (prod)
import { chromium } from '@playwright/test'

const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
const page = await ctx.newPage()
await page.goto('https://work.ultranomic.net/')
await page.waitForLoadState('networkidle')
await page.getByPlaceholder('you@example.com').fill('admin@tandem.local')
await page.getByLabel('Password').fill('tandem-admin')
await page.getByRole('button', { name: 'Sign in', exact: true }).first().click()
await page.waitForURL(u => !u.pathname.includes('login'))
await page.waitForTimeout(1500)

await page.goto('https://work.ultranomic.net/settings')
await page.waitForTimeout(2000)
await page.screenshot({ path: 'qa-shots/mp-settings.png', fullPage: true })

// open provider editor
await page.getByRole('button', { name: 'Add provider' }).first().click()
await page.waitForTimeout(800)
await page.screenshot({ path: 'qa-shots/mp-editor.png' })
await page.keyboard.press('Escape')

// agent editor model access
await page.goto('https://work.ultranomic.net/employees')
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'New employee' }).first().click()
await page.waitForTimeout(800)
await page.getByRole('radio', { name: /AI agent/ }).check()
await page.waitForTimeout(400)
await page.screenshot({ path: 'qa-shots/mp-agent-editor.png', fullPage: true })

const txt = await page.evaluate(() => document.body.innerText)
console.log('PROVIDER-FIELD', txt.includes('Provider'))
console.log('APIKEY-FIELD', txt.includes('API key'))
await b.close()
