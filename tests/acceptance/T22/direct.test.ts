// T22 — Chip pessoal / conexão direta no cadastro da sessão (apps/dashboard; a API não muda).
// Contrato: checkbox data-testid="new-direct-connection" com o rótulo "Chip pessoal / conexão direta (sem proxy)", marcada por
// padrão. Marcada: bloco new-proxy-* oculto e POST /api/sessions sem proxy nem proxyId. Desmarcada: bloco do T18 obrigatório
// (erro em new-proxy-error, sem POST). Lista (session-proxy) e detalhe (detail-proxy) mostram "Conexão direta" quando proxy é null.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  api,
  createSessionWithProxy,
  findSessionByName,
  getSession,
  go,
  randomPhone,
  randomSecret,
  recordApiRequests,
  tid,
  useDashboard,
} from '../T18/shared'

const LABEL = 'Chip pessoal / conexão direta (sem proxy)'
const PROXY_FIELDS = ['new-proxy-protocol', 'new-proxy-host', 'new-proxy-port', 'new-proxy-username', 'new-proxy-password']
const text = async (loc: any) => ((await loc.first().textContent()) ?? '').trim()
const visible = async (page: any, id: string) => {
  const loc = page.locator(tid(id))
  return (await loc.count()) > 0 && (await loc.first().isVisible())
}

describe('T22 — chip pessoal / conexão direta', () => {
  const ctx = useDashboard()

  async function openForm() {
    const page = await ctx.newPage()
    await go(ctx, page, '/sessions')
    await page.locator(tid('add-session')).click()
    await page.locator(tid('new-name')).waitFor({ state: 'visible' })
    return page
  }

  async function fillBasics(page: any, prefix: string) {
    const name = `${prefix}-${randomBytes(3).toString('hex')}`
    await page.locator(tid('new-name')).fill(name)
    await page.locator(tid('new-phone')).fill(randomPhone())
    return name
  }

  const directBox = (page: any) => page.locator(tid('new-direct-connection'))

  async function useProxy(page: any) {
    await directBox(page).uncheck()
    await page.locator(tid('new-proxy-host')).waitFor({ state: 'visible' })
  }

  // ---- AC-T22-01 -------------------------------------------------------------------------------

  it('AC-T22-01 a checkbox "Chip pessoal / conexão direta (sem proxy)" existe e vem marcada', async () => {
    const page = await openForm()
    const box = directBox(page)
    await box.waitFor({ state: 'visible' })
    expect(await box.getAttribute('type'), 'new-direct-connection deve ser um input checkbox').toBe('checkbox')
    expect(await box.isChecked(), 'marcada por padrão').toBe(true)
    expect(await page.getByText(LABEL, { exact: true }).count(), `rótulo "${LABEL}"`).toBeGreaterThan(0)
    // rótulo associado: clicar no texto alterna a checkbox
    await page.getByText(LABEL, { exact: true }).first().click()
    expect(await box.isChecked(), 'clicar no rótulo desmarca').toBe(false)
  })

  it('AC-T22-01 marcada, os campos de proxy ficam ocultos', async () => {
    const page = await openForm()
    await directBox(page).waitFor({ state: 'visible' })
    for (const f of PROXY_FIELDS) expect(await visible(page, f), `${f} deveria estar oculto`).toBe(false)
    await useProxy(page)
    for (const f of PROXY_FIELDS) expect(await visible(page, f), `${f} deveria aparecer ao desmarcar`).toBe(true)
    await directBox(page).check()
    for (const f of PROXY_FIELDS) expect(await visible(page, f), `${f} deveria sumir ao remarcar`).toBe(false)
  })

  it('AC-T22-01 marcada, Gerar QR Code cria a sessão sem proxy nem proxyId e conecta direto', async () => {
    const page = await openForm()
    const seen = recordApiRequests(page)
    const name = await fillBasics(page, 'direto')
    await page.locator(tid('gen-qr')).click()
    const id = await findSessionByName(ctx, name)
    const post = seen.find((r) => r.method === 'POST' && r.path === '/api/sessions')
    expect(post, 'POST /api/sessions').toBeTruthy()
    expect(post!.body?.proxy ?? null, 'body.proxy').toBeNull()
    expect(post!.body?.proxyId ?? null, 'body.proxyId').toBeNull()
    expect((await getSession(ctx, id)).proxy ?? null).toBeNull()
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 10_000, message: 'POST /qr não iniciou a conexão' }).toBe(1)
    expect(ctx.tf.last(id)!.lastConnect?.proxyUrl ?? null, 'conexão direta não usa proxy').toBeFalsy()
    ctx.tf.last(id)!.emitQr('qr-direto')
    await page.locator(tid('qr-image')).waitFor({ state: 'visible', timeout: 15_000 })
  })

  it('AC-T22-01 dados de proxy digitados e depois descartados (remarcar) não vão no POST', async () => {
    const page = await openForm()
    const seen = recordApiRequests(page)
    const name = await fillBasics(page, 'descartado')
    await useProxy(page)
    await page.locator(tid('new-proxy-host')).fill('10.3.3.3')
    await page.locator(tid('new-proxy-port')).fill('3128')
    await directBox(page).check()
    await page.locator(tid('gen-pairing')).click()
    const id = await findSessionByName(ctx, name)
    const post = seen.find((r) => r.method === 'POST' && r.path === '/api/sessions')
    expect(post!.body?.proxy ?? null).toBeNull()
    expect(post!.body?.proxyId ?? null).toBeNull()
    expect((await getSession(ctx, id)).proxy ?? null).toBeNull()
  })

  // ---- AC-T22-02 -------------------------------------------------------------------------------

  const INVALID: Array<[string, Record<string, string>]> = [
    ['bloco vazio', {}],
    ['host sem porta', { host: '10.0.0.1' }],
    ['porta sem host', { port: '8080' }],
    ['porta fora de 1..65535', { host: '10.0.0.1', port: '70000' }],
  ]
  for (const [label, fields] of INVALID) {
    it(`AC-T22-02 desmarcada, proxy obrigatório: ${label} mostra erro e não faz POST`, async () => {
      const page = await openForm()
      const seen = recordApiRequests(page)
      await fillBasics(page, 'obrigatorio')
      await useProxy(page)
      for (const [k, v] of Object.entries(fields)) await page.locator(tid(`new-proxy-${k}`)).fill(v)
      await page.locator(tid('gen-qr')).click()
      const err = page.locator(tid('new-proxy-error'))
      await err.waitFor({ state: 'visible' })
      expect((await text(err)).length).toBeGreaterThan(0)
      await page.locator(tid('gen-pairing')).click()
      await page.waitForTimeout(500)
      expect(seen.filter((r) => r.method === 'POST' && r.path.startsWith('/api/sessions')), 'nenhum POST sem proxy válido').toEqual([])
    })
  }

  it('AC-T22-02 desmarcada com proxy válido, a sessão é criada com o proxy inline e a conexão usa só ele', async () => {
    const page = await openForm()
    const seen = recordApiRequests(page)
    const name = await fillBasics(page, 'com-proxy')
    const pass = randomSecret()
    await useProxy(page)
    await page.locator(tid('new-proxy-protocol')).selectOption('socks5')
    await page.locator(tid('new-proxy-host')).fill('10.22.22.22')
    await page.locator(tid('new-proxy-port')).fill('1080')
    await page.locator(tid('new-proxy-username')).fill('chip')
    await page.locator(tid('new-proxy-password')).fill(pass)
    await page.locator(tid('gen-qr')).click()

    const id = await findSessionByName(ctx, name)
    const post = seen.find((r) => r.method === 'POST' && r.path === '/api/sessions')
    expect(post!.body).toMatchObject({ name, proxy: { protocol: 'socks5', host: '10.22.22.22', username: 'chip', password: pass } })
    expect(Number(post!.body.proxy.port)).toBe(1080)
    expect(post!.body.proxyId ?? null).toBeNull()
    const s = await getSession(ctx, id)
    expect(s.proxy).toMatchObject({ host: '10.22.22.22', hasPassword: true })
    // AC-T06-05: com proxy configurado, nunca conecta sem ele
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 10_000 }).toBe(1)
    expect(String(ctx.tf.last(id)!.lastConnect?.proxyUrl ?? ''), 'conexão deve usar o proxy').toContain('10.22.22.22:1080')
  })

  // ---- AC-T22-03 -------------------------------------------------------------------------------

  it('AC-T22-03 a lista mostra "Conexão direta" para sessão sem proxy e host:porta para sessão com proxy', async () => {
    const direct = await createSessionWithProxy(ctx, null)
    const proxied = await createSessionWithProxy(ctx, { host: '10.50.50.50', port: 3128 })
    const page = await ctx.newPage()
    await go(ctx, page, '/sessions')
    const row = (id: string) => page.locator(`[data-testid="session-row"][data-session-id="${id}"] ${tid('session-proxy')}`)
    await expect.poll(() => text(row(direct.id)), { timeout: 10_000 }).toBe('Conexão direta')
    await expect.poll(() => text(row(proxied.id)), { timeout: 10_000 }).toContain('10.50.50.50')
    expect(await text(row(proxied.id))).toContain('3128')
    expect(await text(row(direct.id))).not.toBe('—')
  })

  it('AC-T22-03 o detalhe mostra "Conexão direta" e permite adicionar um proxy depois (PATCH), com aviso de restart', async () => {
    const s = await createSessionWithProxy(ctx, null)
    const page = await ctx.newPage()
    const seen = recordApiRequests(page)
    await go(ctx, page, `/sessions/${s.id}`)
    await expect.poll(() => text(page.locator(tid('detail-proxy'))), { timeout: 15_000 }).toContain('Conexão direta')

    await page.locator(tid('proxy-edit')).click()
    await page.locator(tid('edit-proxy-host')).fill('10.60.60.60')
    await page.locator(tid('edit-proxy-port')).fill('8080')
    await page.locator(tid('proxy-save')).click()
    await expect.poll(() => text(page.locator(tid('detail-proxy'))), { timeout: 15_000 }).toContain('10.60.60.60')
    await page.locator(tid('proxy-restart-warning')).waitFor({ state: 'visible' })

    const patch = seen.find((r) => r.method === 'PATCH' && r.path === `/api/sessions/${s.id}`)
    expect(patch, 'PATCH /api/sessions/:id').toBeTruthy()
    expect(patch!.body.proxy).toMatchObject({ host: '10.60.60.60' })
    expect(Number(patch!.body.proxy.port)).toBe(8080)
    const after = await api(ctx, 'GET', `/api/sessions/${s.id}`)
    expect(after.body.proxy).toMatchObject({ host: '10.60.60.60' })
  })

  // ---- AC-T22-04 -------------------------------------------------------------------------------

  it('AC-T22-04 o formulário mantém os data-testid do T12/T18 e acrescenta new-direct-connection', async () => {
    const page = await openForm()
    const ids = ['new-direct-connection', 'new-name', 'new-phone', 'new-note', 'gen-qr', 'gen-pairing']
    for (const id of ids) expect(await page.locator(tid(id)).count(), id).toBeGreaterThan(0)
    await useProxy(page)
    for (const id of PROXY_FIELDS) expect(await page.locator(tid(id)).count(), id).toBeGreaterThan(0)
    expect(((await page.locator(tid('gen-qr')).textContent()) ?? '').trim()).toBe('Gerar QR Code')
    expect(((await page.locator(tid('gen-pairing')).textContent()) ?? '').trim()).toBe('Gerar Pairing Code')
    expect(ctx.pageErrors, 'erros de página').toEqual([])
  })
})
