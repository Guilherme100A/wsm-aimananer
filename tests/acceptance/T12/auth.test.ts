// AC-T12-01: login (guardado em memória/sessionStorage); sem token toda rota redireciona ao login.
// O T18 substitui o login por API token por usuário/senha (AC-T18-01); aqui fica o que o AC-T12-01 ainda exige.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { doLogin, go, hashOf, tid, useDashboard } from './shared'

describe('T12 — login', () => {
  const ctx = useDashboard()

  it('AC-T12-01 sem token, toda rota redireciona para #/login', async () => {
    const page = await ctx.newPage({ login: false })
    for (const route of ['/', '/sessions', '/sessions/new', `/sessions/${randomUUID()}`, '/proxies', '/contacts', '/groups', '/alerts']) {
      await go(ctx, page, route)
      await expect.poll(() => hashOf(page), { timeout: 10_000, message: `rota ${route} sem token` }).toMatch(/^#\/login/)
      await expect(page.locator(tid('login-username')).isVisible()).resolves.toBe(true)
    }
  })

  it('AC-T12-01 credencial inválida mostra erro e continua no login, sem guardar token', async () => {
    const page = await ctx.newPage({ login: false })
    await go(ctx, page, '/login')
    await page.locator(tid('login-username')).fill('admin')
    await page.locator(tid('login-password')).fill('senha-errada')
    await page.locator(tid('login-submit')).click()
    await page.locator(tid('login-error')).waitFor({ state: 'visible' })
    expect(await hashOf(page)).toMatch(/^#\/login/)
    const stored = await page.evaluate(() => sessionStorage.getItem('wsm.token'))
    expect(stored === null || stored === '', 'credencial inválida não deve guardar token').toBe(true)
  })

  it('AC-T12-01 login válido entra; token fica só em sessionStorage (nunca localStorage/cookie)', async () => {
    const page = await ctx.newPage({ login: false })
    await doLogin(ctx, page)
    const storage = await page.evaluate(() => ({
      session: sessionStorage.getItem('wsm.token'),
      local: JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))),
      cookie: document.cookie,
    }))
    expect(storage.session, 'token em sessionStorage').toBeTruthy()
    expect(storage.local, 'token no localStorage').not.toContain(storage.session!)
    expect(storage.cookie, 'token em cookie').not.toContain(storage.session!)

    await go(ctx, page, '/contacts')
    await page.locator(tid('page-contacts')).waitFor({ state: 'visible' })
    expect(await hashOf(page)).toMatch(/^#\/contacts/)
  })

  it('AC-T12-01 token não persiste fora da sessão do navegador e logout volta ao login', async () => {
    const page = await ctx.newPage()
    const other = await ctx.newPage({ login: false }) // outro contexto = sem sessionStorage
    await go(ctx, other, '/sessions')
    await expect.poll(() => hashOf(other), { timeout: 10_000 }).toMatch(/^#\/login/)

    await page.locator(tid('nav-logout')).click()
    await expect.poll(() => hashOf(page), { timeout: 10_000 }).toMatch(/^#\/login/)
    expect(await page.evaluate(() => sessionStorage.getItem('wsm.token'))).toBeNull()
    await go(ctx, page, '/sessions')
    await expect.poll(() => hashOf(page), { timeout: 10_000, message: 'após logout, rota deveria exigir login' }).toMatch(/^#\/login/)
  })
})
