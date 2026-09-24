// AC-T12-03: lista de sessões com o indicador de estado da seção 3.2.
// AC-T12-04: "+ Adicionar número" → formulário (Nome, Número, Proxy/IP, Observação) com "Gerar QR Code" e
// "Gerar Pairing Code"; QR/código exibido e atualizado até conectar.
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { api, createSession, enableProxyFields, go, hashOf, INDICATORS, randomPhone, setStatus, statusOf, tid, useDashboard } from './shared'

describe('T12 — lista de sessões e adicionar número', () => {
  const ctx = useDashboard()

  it('AC-T12-03 cada estado aparece com o indicador exato da tabela 3.2', async () => {
    const ids: Record<string, string> = {}
    for (const st of Object.keys(INDICATORS)) {
      const s = await createSession(ctx)
      if (st !== 'NEW') setStatus(ctx, s.id, st)
      ids[st] = s.id
    }
    const page = await ctx.newPage()
    await go(ctx, page, '/sessions')
    for (const [st, id] of Object.entries(ids)) {
      const row = page.locator(`${tid('session-row')}[data-session-id="${id}"]`)
      await row.waitFor({ state: 'visible' })
      await expect.poll(() => row.getAttribute('data-state'), { timeout: 10_000 }).toBe(st)
      const text = ((await row.locator(tid('session-state')).textContent()) ?? '').trim()
      expect(text, `indicador de ${st}`).toBe(INDICATORS[st])
    }
  })

  it('AC-T12-03 o indicador acompanha a mudança de estado e o link abre o detalhe', async () => {
    const s = await createSession(ctx)
    setStatus(ctx, s.id, 'STABLE')
    const page = await ctx.newPage()
    await go(ctx, page, '/sessions')
    const row = page.locator(`${tid('session-row')}[data-session-id="${s.id}"]`)
    await expect.poll(async () => ((await row.locator(tid('session-state')).textContent()) ?? '').trim(), { timeout: 10_000 }).toBe(INDICATORS.STABLE)
    setStatus(ctx, s.id, 'DEGRADED')
    await expect.poll(async () => ((await row.locator(tid('session-state')).textContent()) ?? '').trim(), { timeout: 15_000, message: 'lista não atualizou o estado' }).toBe(INDICATORS.DEGRADED)
    await row.locator(tid('session-link')).click()
    await expect.poll(() => hashOf(page), { timeout: 10_000 }).toBe(`#/sessions/${s.id}`)
  })

  // T18 (AC-T18-02): o proxy passa a ser informado inline no formulário (sem select de proxies cadastrados).
  it('AC-T12-04 "+ Adicionar número" abre o formulário com Nome, Número, Proxy, Observação e os dois botões', async () => {
    const page = await ctx.newPage()
    await go(ctx, page, '/sessions')
    const add = page.locator(tid('add-session'))
    expect(((await add.textContent()) ?? '').trim()).toBe('+ Adicionar número')
    await add.click()
    await enableProxyFields(page) // T22: o bloco de proxy vem oculto (conexão direta marcada)
    for (const f of ['new-name', 'new-phone', 'new-proxy-protocol', 'new-proxy-host', 'new-proxy-port', 'new-note']) await page.locator(tid(f)).waitFor({ state: 'visible' })
    for (const label of ['Nome', 'Número', 'Proxy', 'Observação']) expect(await page.getByText(label, { exact: true }).count(), `rótulo ${label}`).toBeGreaterThan(0)
    expect(((await page.locator(tid('gen-qr')).textContent()) ?? '').trim()).toBe('Gerar QR Code')
    expect(((await page.locator(tid('gen-pairing')).textContent()) ?? '').trim()).toBe('Gerar Pairing Code')
  })

  it('AC-T12-04 Gerar QR Code: cria a sessão, mostra o QR, atualiza quando chega QR novo e mostra conectado ao autenticar', async () => {
    const page = await ctx.newPage()
    await go(ctx, page, '/sessions/new')
    const name = `qr-${randomBytes(3).toString('hex')}`
    await page.locator(tid('new-name')).fill(name)
    await page.locator(tid('new-phone')).fill(randomPhone())
    await enableProxyFields(page) // T22
    await page.locator(tid('new-proxy-host')).fill('127.0.0.1')
    await page.locator(tid('new-proxy-port')).fill('18081')
    await page.locator(tid('new-note')).fill('observação do teste')
    await page.locator(tid('gen-qr')).click()

    let id = ''
    await expect.poll(async () => {
      const list = await api(ctx, 'GET', '/api/sessions')
      const items: any[] = Array.isArray(list.body) ? list.body : (list.body?.items ?? [])
      id = items.find((s) => s.name === name)?.id ?? ''
      return id
    }, { timeout: 10_000, message: 'sessão não criada pela UI' }).not.toBe('')
    const created = await api(ctx, 'GET', `/api/sessions/${id}`)
    expect(created.body).toMatchObject({ name, note: 'observação do teste', proxy: { host: '127.0.0.1' } })
    expect(Number(created.body.proxy.port)).toBe(18081)
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 10_000, message: 'POST /qr não iniciou a conexão' }).toBe(1)
    const t = ctx.tf.last(id)!

    t.emitQr('qr-primeiro')
    const img = page.locator(tid('qr-image'))
    await img.waitFor({ state: 'visible', timeout: 15_000 })
    const first = await img.getAttribute('src')
    expect(first).toMatch(/^data:image\//)
    t.emitQr('qr-segundo')
    await expect.poll(() => img.getAttribute('src'), { timeout: 15_000, message: 'QR não foi atualizado' }).not.toBe(first)

    await t.login()
    await page.locator(tid('auth-connected')).waitFor({ state: 'visible', timeout: 15_000 })
    expect(await page.locator(tid('qr-image')).count(), 'QR deveria sumir ao conectar').toBe(0)
    expect(statusOf(ctx, id)).toBe('WARMING')
    await page.locator(tid('session-open')).click()
    await expect.poll(() => hashOf(page), { timeout: 10_000 }).toBe(`#/sessions/${id}`)
  })

  it('AC-T12-04 Gerar Pairing Code: mostra o código do transporte e depois conectado', async () => {
    const page = await ctx.newPage()
    await go(ctx, page, '/sessions/new')
    const name = `pair-${randomBytes(3).toString('hex')}`
    await page.locator(tid('new-name')).fill(name)
    await page.locator(tid('new-phone')).fill(randomPhone())
    await page.locator(tid('gen-pairing')).click()
    const code = page.locator(tid('pairing-code'))
    await code.waitFor({ state: 'visible', timeout: 15_000 })
    const list = await api(ctx, 'GET', '/api/sessions')
    const items: any[] = Array.isArray(list.body) ? list.body : (list.body?.items ?? [])
    const id = items.find((s) => s.name === name)?.id
    expect(id, 'sessão não criada').toBeTruthy()
    const t = ctx.tf.last(id)!
    await expect.poll(async () => ((await code.textContent()) ?? '').replace(/\W/g, ''), { timeout: 10_000 }).toBe(t.pairingCode)
    await t.login()
    await page.locator(tid('auth-connected')).waitFor({ state: 'visible', timeout: 15_000 })
  })

  it('AC-T12-04 erro da API (telefone inválido) aparece no formulário', async () => {
    const page = await ctx.newPage()
    await go(ctx, page, '/sessions/new')
    await page.locator(tid('new-name')).fill('invalida')
    await page.locator(tid('new-phone')).fill('123')
    await page.locator(tid('gen-qr')).click()
    await page.locator(tid('auth-error')).waitFor({ state: 'visible' })
    expect(((await page.locator(tid('auth-error')).textContent()) ?? '').trim().length).toBeGreaterThan(0)
  })
})
