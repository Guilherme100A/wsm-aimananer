// AC-T18-02 — "+ Adicionar número": Nome, Número, Proxy (Protocolo, IP/Host, Porta, Usuário, Senha, opcionais em bloco) e
// Observação, com "Gerar QR Code" e "Gerar Pairing Code". A sessão é criada com o proxy inline (AC-T17-03);
// proxy incompleto é validado no cliente.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { lit, sqlOk } from '../helpers/pg'
import { findSessionByName, getSession, go, randomPhone, randomSecret, recordApiRequests, tid, useDashboard } from './shared'

const LABELS = ['Nome', 'Número', 'Proxy', 'Protocolo', 'IP/Host', 'Porta', 'Usuário', 'Senha', 'Observação']

describe('T18 — adicionar número com proxy', () => {
  const ctx = useDashboard()

  async function openForm() {
    const page = await ctx.newPage()
    await go(ctx, page, '/sessions')
    await page.locator(tid('add-session')).click()
    await page.locator(tid('new-name')).waitFor({ state: 'visible' })
    return page
  }

  it('AC-T18-02 o formulário tem Nome, Número, bloco Proxy (Protocolo, IP/Host, Porta, Usuário, Senha), Observação e os dois botões', async () => {
    const page = await openForm()
    for (const f of ['new-name', 'new-phone', 'new-proxy-protocol', 'new-proxy-host', 'new-proxy-port', 'new-proxy-username', 'new-proxy-password', 'new-note'])
      await page.locator(tid(f)).waitFor({ state: 'visible' })
    for (const label of LABELS) expect(await page.getByText(label, { exact: true }).count(), `rótulo ${label}`).toBeGreaterThan(0)
    const protocols = await page.locator(`${tid('new-proxy-protocol')} option`).evaluateAll((els: any[]) => els.map((e) => e.value))
    expect(protocols).toEqual(expect.arrayContaining(['http', 'https', 'socks5']))
    expect(await page.locator(tid('new-proxy-password')).getAttribute('type')).toBe('password')
    expect(await page.locator(tid('new-proxy')).count(), 'select antigo de proxies cadastrados').toBe(0)
    expect(((await page.locator(tid('gen-qr')).textContent()) ?? '').trim()).toBe('Gerar QR Code')
    expect(((await page.locator(tid('gen-pairing')).textContent()) ?? '').trim()).toBe('Gerar Pairing Code')
  })

  it('AC-T18-02 Gerar QR Code cria a sessão com o proxy inline e a conexão usa esse proxy', async () => {
    const page = await openForm()
    const seen = recordApiRequests(page)
    const name = `proxy-${randomBytes(3).toString('hex')}`
    const pass = randomSecret()
    await page.locator(tid('new-name')).fill(name)
    await page.locator(tid('new-phone')).fill(randomPhone())
    await page.locator(tid('new-proxy-protocol')).selectOption('socks5')
    await page.locator(tid('new-proxy-host')).fill('10.9.8.7')
    await page.locator(tid('new-proxy-port')).fill('1080')
    await page.locator(tid('new-proxy-username')).fill('operador')
    await page.locator(tid('new-proxy-password')).fill(pass)
    await page.locator(tid('new-note')).fill('com proxy')
    await page.locator(tid('gen-qr')).click()

    const id = await findSessionByName(ctx, name)
    const post = seen.find((r) => r.method === 'POST' && r.path === '/api/sessions')
    expect(post, 'POST /api/sessions').toBeTruthy()
    expect(post!.body).toMatchObject({ name, note: 'com proxy', proxy: { protocol: 'socks5', host: '10.9.8.7', username: 'operador', password: pass } })
    expect(Number(post!.body.proxy.port)).toBe(1080)
    expect(post!.body.proxyId ?? null, 'não usa mais proxyId').toBeNull()

    const s = await getSession(ctx, id)
    expect(s.note).toBe('com proxy')
    expect(s.proxy).toMatchObject({ protocol: 'socks5', host: '10.9.8.7', username: 'operador', hasPassword: true })
    expect(Number(s.proxy.port)).toBe(1080)
    expect(JSON.stringify(s), 'GET /api/sessions/:id expõe a senha').not.toContain(pass)
    const proxyRows = sqlOk(ctx.tempDb.url, `SELECT row_to_json(p)::text FROM proxies p JOIN sessions s ON s.proxy_id = p.id WHERE s.id = ${lit(id)};`)
    expect(proxyRows.length, 'proxy vinculado no banco').toBe(1)
    expect(proxyRows[0]![0], 'senha do proxy em texto puro no banco').not.toContain(pass)

    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 10_000, message: 'POST /qr não iniciou a conexão' }).toBe(1)
    const t = ctx.tf.last(id)!
    expect(String(t.lastConnect?.proxyUrl ?? ''), 'conexão deve usar o proxy da sessão').toContain('10.9.8.7:1080')
    t.emitQr('qr-proxy')
    await page.locator(tid('qr-image')).waitFor({ state: 'visible', timeout: 15_000 })
  })

  it('AC-T18-02 bloco de proxy vazio cria a sessão sem proxy', async () => {
    const page = await openForm()
    const seen = recordApiRequests(page)
    const name = `sem-proxy-${randomBytes(3).toString('hex')}`
    await page.locator(tid('new-name')).fill(name)
    await page.locator(tid('new-phone')).fill(randomPhone())
    await page.locator(tid('gen-qr')).click()
    const id = await findSessionByName(ctx, name)
    const post = seen.find((r) => r.method === 'POST' && r.path === '/api/sessions')
    expect(post?.body?.proxy ?? null).toBeNull()
    expect((await getSession(ctx, id)).proxy ?? null).toBeNull()
  })

  it('AC-T18-02 Gerar Pairing Code também cria a sessão com o proxy inline', async () => {
    const page = await openForm()
    const name = `pair-proxy-${randomBytes(3).toString('hex')}`
    await page.locator(tid('new-name')).fill(name)
    await page.locator(tid('new-phone')).fill(randomPhone())
    await page.locator(tid('new-proxy-host')).fill('10.1.1.1')
    await page.locator(tid('new-proxy-port')).fill('8080')
    await page.locator(tid('gen-pairing')).click()
    await page.locator(tid('pairing-code')).waitFor({ state: 'visible', timeout: 15_000 })
    const id = await findSessionByName(ctx, name)
    const s = await getSession(ctx, id)
    expect(s.proxy).toMatchObject({ host: '10.1.1.1', hasPassword: false })
    expect(Number(s.proxy.port)).toBe(8080)
  })

  const INVALID: Array<[string, Record<string, string>]> = [
    ['host sem porta', { host: '10.0.0.1' }],
    ['porta sem host', { port: '8080' }],
    ['porta fora de 1..65535', { host: '10.0.0.1', port: '70000' }],
    ['usuário sem host', { username: 'fulano' }],
    ['senha sem usuário', { host: '10.0.0.1', port: '8080', password: 'x1y2z3' }],
  ]
  for (const [label, fields] of INVALID) {
    it(`AC-T18-02 proxy incompleto (${label}) é barrado no cliente, sem chamar a API`, async () => {
      const page = await openForm()
      const seen = recordApiRequests(page)
      const name = `invalido-${randomBytes(3).toString('hex')}`
      await page.locator(tid('new-name')).fill(name)
      await page.locator(tid('new-phone')).fill(randomPhone())
      for (const [k, v] of Object.entries(fields)) await page.locator(tid(`new-proxy-${k}`)).fill(v)
      await page.locator(tid('gen-qr')).click()
      const err = page.locator(tid('new-proxy-error'))
      await err.waitFor({ state: 'visible' })
      expect(((await err.textContent()) ?? '').trim().length).toBeGreaterThan(0)
      await page.waitForTimeout(500)
      expect(seen.filter((r) => r.method === 'POST' && r.path.startsWith('/api/sessions')), 'nenhum POST com proxy inválido').toEqual([])
    })
  }
})
