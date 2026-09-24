// AC-T12-01: login com API token (memória/sessionStorage); sem token toda rota redireciona ao login.
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
      await expect(page.locator(tid('login-token')).isVisible()).resolves.toBe(true)
    }
  })

  it('AC-T12-01 token inválido mostra erro e continua no login', async () => {
    const page = await ctx.newPage({ login: false })
    await go(ctx, page, '/login')
    await page.locator(tid('login-token')).fill('token-errado')
    await page.locator(tid('login-submit')).click()
    await page.locator(tid('login-error')).waitFor({ state: 'visible' })
    expect(await hashOf(page)).toMatch(/^#\/login/)
    const stored = await page.evaluate(() => sessionStorage.getItem('wsm.token'))
    expect(stored === null || stored === '', 'token inválido não deve ser guardado').toBe(true)
  })

  it('AC-T12-01 token válido entra; token fica só em sessionStorage (nunca localStorage/cookie)', async () => {
    const page = await ctx.newPage({ login: false })
    await doLogin(ctx, page)
    const storage = await page.evaluate(() => ({
      session: sessionStorage.getItem('wsm.token'),
      local: JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))),
      cookie: document.cookie,
    }))
    expect(storage.session).toBe(ctx.token)
    expect(storage.local, 'token no localStorage').not.toContain(ctx.token)
    expect(storage.cookie, 'token em cookie').not.toContain(ctx.token)

    await go(ctx, page, '/proxies')
    await page.locator(tid('page-proxies')).waitFor({ state: 'visible' })
    expect(await hashOf(page)).toMatch(/^#\/proxies/)
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
