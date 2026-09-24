// AC-T18-04 — `pnpm --filter @wsm/dashboard build` passa; smoke Playwright: login admin/nimda → adicionar número com
// proxy → QR → conectado → detalhe mostra o proxy.
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tail } from '../helpers/exec'
import { ADMIN_PASSWORD, ADMIN_USERNAME, DIST, enableProxyFields, buildDashboard, findSessionByName, go, hashOf, randomPhone, statusOf, tid, useDashboard } from './shared'

describe('T18 — build', () => {
  it('AC-T18-04 pnpm --filter @wsm/dashboard build passa e o bundle não guarda o token em localStorage', () => {
    const r = buildDashboard()
    expect(r.code, tail(r, 60)).toBe(0)
    expect(existsSync(join(DIST, 'index.html'))).toBe(true)
    const assets = join(DIST, 'assets')
    const bundle = readdirSync(assets)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(assets, f), 'utf8'))
      .join('\n')
    expect(bundle).toContain('/api/auth/login')
    expect(bundle, 'token não pode ir para localStorage').not.toMatch(/localStorage\.setItem\(\s*["'`]wsm\.token/)
  })
})

describe('T18 — smoke E2E', () => {
  const ctx = useDashboard()

  it('AC-T18-04 smoke: login admin/nimda → adicionar número com proxy → QR → conectado → detalhe mostra o proxy', async () => {
    const consoleErrors: string[] = []
    const page = await ctx.newPage({ login: false })
    page.on('console', (m: any) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text())
    })

    await go(ctx, page, '/')
    await expect.poll(() => hashOf(page), { timeout: 10_000 }).toMatch(/^#\/login/)
    await page.locator(tid('login-username')).fill(ADMIN_USERNAME)
    await page.locator(tid('login-password')).fill(ADMIN_PASSWORD)
    await page.locator(tid('login-submit')).click()
    await page.locator(tid('card-connected')).waitFor({ state: 'visible', timeout: 15_000 })

    await page.locator(tid('nav-sessions')).click()
    await page.locator(tid('add-session')).click()
    const name = `smoke18-${randomBytes(3).toString('hex')}`
    await page.locator(tid('new-name')).fill(name)
    await page.locator(tid('new-phone')).fill(randomPhone())
    await enableProxyFields(page) // T22: bloco de proxy oculto por padrão
    await page.locator(tid('new-proxy-protocol')).selectOption('http')
    await page.locator(tid('new-proxy-host')).fill('10.44.44.44')
    await page.locator(tid('new-proxy-port')).fill('3129')
    await page.locator(tid('new-proxy-username')).fill('smoke')
    await page.locator(tid('new-proxy-password')).fill('segredo-smoke-18')
    await page.locator(tid('new-note')).fill('smoke T18')
    await page.locator(tid('gen-qr')).click()

    const id = await findSessionByName(ctx, name)
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 10_000 }).toBe(1)
    const t = ctx.tf.last(id)!
    t.emitQr('smoke18-qr')
    await page.locator(tid('qr-image')).waitFor({ state: 'visible', timeout: 15_000 })
    await t.login()
    await page.locator(tid('auth-connected')).waitFor({ state: 'visible', timeout: 15_000 })
    expect(statusOf(ctx, id)).toBe('WARMING')

    await page.locator(tid('session-open')).click()
    await expect.poll(() => hashOf(page), { timeout: 10_000 }).toBe(`#/sessions/${id}`)
    const panel = page.locator(tid('detail-proxy'))
    await expect.poll(async () => ((await panel.textContent()) ?? ''), { timeout: 15_000 }).toContain('10.44.44.44')
    const shown = (await panel.textContent()) ?? ''
    expect(shown).toContain('3129')
    expect(shown).not.toContain('segredo-smoke-18')

    expect(ctx.pageErrors, 'exceções não tratadas na página').toEqual([])
    expect(consoleErrors, 'erros no console').toEqual([])
  })
})
