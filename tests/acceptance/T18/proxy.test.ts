// AC-T18-03 — a página Proxies sai da navegação; o detalhe da sessão mostra o proxy (senha mascarada) e permite editar
// ou remover via PATCH (AC-T17-04), avisando que exige restart; a lista de sessões mostra o IP do proxy de cada número.
import { describe, expect, it } from 'vitest'
import { DIRECT_CONNECTION, createSessionWithProxy, getSession, go, hashOf, randomSecret, recordApiRequests, tid, useDashboard } from './shared'

const text = async (loc: any) => ((await loc.textContent()) ?? '').trim()

describe('T18 — proxy dentro da sessão', () => {
  const ctx = useDashboard()

  it('AC-T18-03 a navegação não tem Proxies e #/proxies redireciona para as sessões', async () => {
    const page = await ctx.newPage()
    await page.locator(tid('nav-sessions')).waitFor({ state: 'visible' })
    expect(await page.locator(tid('nav-proxies')).count(), 'link nav-proxies').toBe(0)
    expect(await page.locator('a[href*="#/proxies"]').count(), 'algum link para #/proxies').toBe(0)
    await go(ctx, page, '/proxies')
    await expect.poll(() => hashOf(page), { timeout: 10_000 }).toMatch(/^#\/sessions\/?$/)
    expect(await page.locator(tid('page-proxies')).count()).toBe(0)
  })

  it('AC-T18-03 a lista de sessões mostra o IP do proxy de cada número (ou Conexão direta, T22)', async () => {
    const withProxy = await createSessionWithProxy(ctx, { host: '10.20.30.40', port: 3128 })
    const without = await createSessionWithProxy(ctx, null)
    const page = await ctx.newPage()
    await go(ctx, page, '/sessions')
    const rowA = page.locator(`${tid('session-row')}[data-session-id="${withProxy.id}"]`)
    const rowB = page.locator(`${tid('session-row')}[data-session-id="${without.id}"]`)
    await rowA.waitFor({ state: 'visible' })
    await expect.poll(() => text(rowA.locator(tid('session-proxy'))), { timeout: 10_000 }).toContain('10.20.30.40')
    expect(await text(rowA.locator(tid('session-proxy')))).toContain('3128')
    await expect.poll(() => text(rowB.locator(tid('session-proxy'))), { timeout: 10_000 }).toBe(DIRECT_CONNECTION)
  })

  it('AC-T18-03 o detalhe mostra o proxy com a senha mascarada', async () => {
    const pass = randomSecret()
    const s = await createSessionWithProxy(ctx, { protocol: 'http', host: '10.5.5.5', port: 8081, username: 'usr', password: pass })
    const page = await ctx.newPage()
    await go(ctx, page, `/sessions/${s.id}`)
    const panel = page.locator(tid('detail-proxy'))
    await expect.poll(() => text(panel), { timeout: 15_000 }).toContain('10.5.5.5')
    const t = await text(panel)
    expect(t).toContain('8081')
    expect(t).toContain('usr')
    expect(t).toContain('***')
    expect(t).not.toContain(pass)
    expect(await page.content(), 'senha do proxy no HTML').not.toContain(pass)
  })

  it('AC-T18-03 editar o proxy no detalhe faz PATCH, avisa que exige restart e mostra o novo proxy', async () => {
    const s = await createSessionWithProxy(ctx, { host: '10.6.6.6', port: 8000 })
    const page = await ctx.newPage()
    const seen = recordApiRequests(page)
    await go(ctx, page, `/sessions/${s.id}`)
    await expect.poll(() => text(page.locator(tid('detail-proxy'))), { timeout: 15_000 }).toContain('10.6.6.6')

    await page.locator(tid('proxy-edit')).click()
    const warning = page.locator(tid('proxy-restart-warning'))
    await warning.waitFor({ state: 'visible' })
    expect(await text(warning)).toMatch(/restart/i)

    const pass = randomSecret()
    await page.locator(tid('edit-proxy-protocol')).selectOption('socks5')
    await page.locator(tid('edit-proxy-host')).fill('10.7.7.7')
    await page.locator(tid('edit-proxy-port')).fill('1081')
    await page.locator(tid('edit-proxy-username')).fill('novo')
    await page.locator(tid('edit-proxy-password')).fill(pass)
    await page.locator(tid('proxy-save')).click()

    await expect.poll(() => seen.find((r) => r.method === 'PATCH' && r.path === `/api/sessions/${s.id}`), { timeout: 10_000, message: 'PATCH /api/sessions/:id' }).toBeTruthy()
    const patch = seen.find((r) => r.method === 'PATCH')!
    expect(patch.body?.proxy).toMatchObject({ protocol: 'socks5', host: '10.7.7.7', username: 'novo', password: pass })

    await expect.poll(async () => (await getSession(ctx, s.id)).proxy?.host, { timeout: 10_000 }).toBe('10.7.7.7')
    const after = await getSession(ctx, s.id)
    expect(Number(after.proxy.port)).toBe(1081)
    expect(after.requiresRestart).toBe(true)
    await expect.poll(() => text(page.locator(tid('detail-proxy'))), { timeout: 15_000 }).toContain('10.7.7.7')
    expect(await text(page.locator(tid('detail-proxy')))).not.toContain(pass)
    await page.locator(tid('proxy-restart-warning')).waitFor({ state: 'visible' })
    expect(await text(page.locator(tid('proxy-restart-warning')))).toMatch(/restart/i)
  })

  it('AC-T18-03 remover o proxy no detalhe faz PATCH {proxy:null} e mostra Conexão direta (T22)', async () => {
    const s = await createSessionWithProxy(ctx, { host: '10.8.8.8', port: 8888 })
    const page = await ctx.newPage()
    page.on('dialog', (d: any) => d.accept().catch(() => {}))
    const seen = recordApiRequests(page)
    await go(ctx, page, `/sessions/${s.id}`)
    await expect.poll(() => text(page.locator(tid('detail-proxy'))), { timeout: 15_000 }).toContain('10.8.8.8')
    await page.locator(tid('proxy-edit')).click()
    await page.locator(tid('proxy-remove')).click()

    await expect.poll(() => seen.find((r) => r.method === 'PATCH' && r.path === `/api/sessions/${s.id}`), { timeout: 10_000 }).toBeTruthy()
    expect(seen.find((r) => r.method === 'PATCH')!.body).toMatchObject({ proxy: null })
    await expect.poll(async () => (await getSession(ctx, s.id)).proxy ?? null, { timeout: 10_000 }).toBeNull()
    await expect.poll(() => text(page.locator(tid('detail-proxy'))), { timeout: 15_000 }).toContain(DIRECT_CONNECTION)
    await page.locator(tid('proxy-restart-warning')).waitFor({ state: 'visible' })
  })

  it('AC-T18-03 edição com proxy incompleto mostra proxy-error e não faz PATCH', async () => {
    const s = await createSessionWithProxy(ctx, { host: '10.9.9.9', port: 9000 })
    const page = await ctx.newPage()
    const seen = recordApiRequests(page)
    await go(ctx, page, `/sessions/${s.id}`)
    await expect.poll(() => text(page.locator(tid('detail-proxy'))), { timeout: 15_000 }).toContain('10.9.9.9')
    await page.locator(tid('proxy-edit')).click()
    await page.locator(tid('edit-proxy-port')).fill('')
    await page.locator(tid('proxy-save')).click()
    await page.locator(tid('proxy-error')).waitFor({ state: 'visible' })
    await page.waitForTimeout(500)
    expect(seen.filter((r) => r.method === 'PATCH')).toEqual([])
    expect((await getSession(ctx, s.id)).proxy?.host).toBe('10.9.9.9')
  })
})
