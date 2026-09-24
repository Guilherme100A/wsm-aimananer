// AC-T12-07: `pnpm --filter dashboard build` passa e o smoke E2E (Playwright) contra a API com FakeTransport passa.
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tail } from '../helpers/exec'
import { ADMIN_PASSWORD, ADMIN_USERNAME, api, buildDashboard, DIST, go, hashOf, randomPhone, statusOf, tid, useDashboard } from './shared'

describe('T12 — build', () => {
  it('AC-T12-07 pnpm --filter @wsm/dashboard build passa e gera dist/index.html sem URL absoluta de API', () => {
    const r = buildDashboard()
    expect(r.code, tail(r, 60)).toBe(0)
    expect(existsSync(join(DIST, 'index.html'))).toBe(true)
    const assets = join(DIST, 'assets')
    const js = readdirSync(assets).filter((f) => f.endsWith('.js'))
    expect(js.length).toBeGreaterThan(0)
    const bundle = js.map((f) => readFileSync(join(assets, f), 'utf8')).join('\n')
    expect(bundle, 'API deve ser chamada por caminho relativo').not.toMatch(/https?:\/\/(localhost|127\.0\.0\.1):3000\/api/)
    expect(bundle, 'token não pode ir para localStorage').not.toMatch(/localStorage\.setItem\(\s*["'`]wsm\.token/)
  })
})

describe('T12 — smoke E2E', () => {
  const ctx = useDashboard()

  it('AC-T12-07 smoke: login → home → sessões → adicionar número por QR até conectar → detalhe → pausar', async () => {
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
    const name = `smoke-${randomBytes(3).toString('hex')}`
    await page.locator(tid('new-name')).fill(name)
    await page.locator(tid('new-phone')).fill(randomPhone())
    await page.locator(tid('gen-qr')).click()

    let id = ''
    await expect.poll(async () => {
      const list = await api(ctx, 'GET', '/api/sessions')
      const items: any[] = Array.isArray(list.body) ? list.body : (list.body?.items ?? [])
      id = items.find((s) => s.name === name)?.id ?? ''
      return id
    }, { timeout: 10_000 }).not.toBe('')
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 10_000 }).toBe(1)
    const t = ctx.tf.last(id)!
    t.emitQr('smoke-qr')
    await page.locator(tid('qr-image')).waitFor({ state: 'visible', timeout: 15_000 })
    await t.login()
    await page.locator(tid('auth-connected')).waitFor({ state: 'visible', timeout: 15_000 })

    await page.locator(tid('session-open')).click()
    await page.locator(tid('session-card')).waitFor({ state: 'visible' })
    await page.locator(tid('btn-pause')).click()
    await expect.poll(() => statusOf(ctx, id), { timeout: 10_000 }).toBe('PAUSED')

    await page.locator(tid('nav-sessions')).click()
    const row = page.locator(`${tid('session-row')}[data-session-id="${id}"]`)
    await expect.poll(async () => ((await row.locator(tid('session-state')).textContent()) ?? '').trim(), { timeout: 15_000 }).toBe('🔴 Paused')

    expect(ctx.pageErrors, 'exceções não tratadas na página').toEqual([])
    expect(consoleErrors, 'erros no console').toEqual([])
  })
})
