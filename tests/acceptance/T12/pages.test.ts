// AC-T12-06: páginas Contatos (com import CSV), Grupos e Alertas/Webhooks (Proxies saiu da navegação no T18).
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { api, connectedSession, go, hashOf, tid, useDashboard } from './shared'

const phone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`

describe('T12 — páginas', () => {
  const ctx = useDashboard()

  // T18 (AC-T18-03) tirou a página Proxies da navegação: o proxy é configurado na própria sessão.
  it('AC-T12-06 navegação leva às páginas Contatos, Grupos e Alertas/Webhooks com seus títulos', async () => {
    const page = await ctx.newPage()
    const pages: Array<[string, string, string, string]> = [
      ['nav-contacts', '#/contacts', 'page-contacts', 'Contatos'],
      ['nav-groups', '#/groups', 'page-groups', 'Grupos'],
      ['nav-alerts', '#/alerts', 'page-alerts', 'Alertas / Webhooks'],
    ]
    for (const [nav, hash, pageId, title] of pages) {
      await page.locator(tid(nav)).click()
      await expect.poll(() => hashOf(page), { timeout: 10_000 }).toBe(hash)
      await page.locator(tid(pageId)).waitFor({ state: 'visible' })
      expect(((await page.locator(`${tid(pageId)} h1, h1`).first().textContent()) ?? '').trim()).toBe(title)
    }
  })

  it('AC-T12-06 Contatos: import CSV pelo arquivo mostra o resultado e os contatos aparecem na lista', async () => {
    const p1 = phone()
    const p2 = phone()
    const csv = ['name,phone,consent,consent_at,consent_source', `Ana,${p1},true,2026-09-01T12:00:00Z,formulario`, `Bia,${p2},true,2026-09-01T12:00:00Z,evento`].join('\n')
    const page = await ctx.newPage()
    await go(ctx, page, '/contacts')
    await page.locator(tid('page-contacts')).waitFor({ state: 'visible' })
    await page.locator(tid('csv-file')).setInputFiles({ name: 'contatos.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await page.locator(tid('csv-import')).click()
    await expect.poll(async () => ((await page.locator(tid('csv-result')).textContent()) ?? ''), { timeout: 15_000 }).toMatch(/imported\s*2/i)
    await expect.poll(async () => (await page.locator(tid('page-contacts')).textContent()) ?? '', { timeout: 15_000 }).toContain(p1)
    expect((await page.locator(tid('page-contacts')).textContent()) ?? '').toContain(p2)
    const list = await api(ctx, 'GET', '/api/contacts')
    expect(JSON.stringify(list.body)).toContain(p1)
  })

  it('AC-T12-06 Grupos: escolher a sessão lista os grupos com nome e participantes', async () => {
    const { id, name, transport } = await connectedSession(ctx)
    const g = `Grupo ${randomBytes(3).toString('hex')}`
    transport.setGroups([{ id: '120363000000000001@g.us', name: g, participants: 42, announce: false }])
    const page = await ctx.newPage()
    await go(ctx, page, '/groups')
    await page.locator(tid('page-groups')).waitFor({ state: 'visible' })
    const select = page.locator(tid('groups-session'))
    await expect.poll(() => select.locator(`option[value="${id}"]`).count(), { timeout: 15_000 }).toBe(1)
    await select.selectOption(id)
    const row = page.locator(tid('group-row')).filter({ hasText: g })
    await row.waitFor({ state: 'visible', timeout: 15_000 })
    expect((await row.textContent()) ?? '').toContain('42')
    expect(name).toBeTruthy()
  })

  it('AC-T12-06 Alertas/Webhooks: lista os webhooks e cria um pelo formulário (segredo nunca exibido)', async () => {
    const secret = `whsec_${randomBytes(8).toString('hex')}`
    const pre = await api(ctx, 'POST', '/api/webhooks', { name: 'existente', channel: 'http', url: 'http://127.0.0.1:18099/hook', secret })
    expect(pre.status, pre.text).toBe(201)
    const page = await ctx.newPage()
    await go(ctx, page, '/alerts')
    await page.locator(tid('webhook-row')).filter({ hasText: 'existente' }).waitFor({ state: 'visible', timeout: 15_000 })

    const name = `novo-${randomBytes(3).toString('hex')}`
    const secret2 = `whsec_${randomBytes(8).toString('hex')}`
    await page.locator(tid('webhook-name')).fill(name)
    await page.locator(tid('webhook-channel')).selectOption('http')
    await page.locator(tid('webhook-url')).fill('http://127.0.0.1:18099/novo')
    await page.locator(tid('webhook-secret')).fill(secret2)
    await page.locator(tid('webhook-save')).click()
    await page.locator(tid('webhook-row')).filter({ hasText: name }).waitFor({ state: 'visible', timeout: 15_000 })
    const list = await api(ctx, 'GET', '/api/webhooks')
    const items: any[] = Array.isArray(list.body) ? list.body : (list.body?.items ?? [])
    expect(items.find((w) => w.name === name)).toMatchObject({ channel: 'http', url: 'http://127.0.0.1:18099/novo', hasSecret: true })
    const html = await page.content()
    expect(html).not.toContain(secret)
  })
})
