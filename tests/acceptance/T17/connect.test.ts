// AC-T17-06: a sessão com proxy inline conecta só pelo proxy (sem fallback direto, T06); após trocar o
// proxy via PATCH, o restart aplica o novo proxy. As suítes T03/T05/T06/T16 são rodadas à parte pelo Tester.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { lit, sqlOk } from '../helpers/pg'
import { api, randomPhone, statusOf, useSessions } from '../T05/shared'

describe('T17 — conexão pelo proxy da sessão', () => {
  const ctx = useSessions()

  async function create(proxy: Record<string, unknown>) {
    const res = await api(ctx, 'POST', '/api/sessions', { name: `conn-${randomBytes(3).toString('hex')}`, phone: randomPhone(), proxy })
    expect(res.status, res.text).toBe(201)
    return res.body as Record<string, any>
  }

  it('AC-T17-06 sessão criada com proxy inline conecta pelo proxy (host, porta e credenciais corretas)', async () => {
    const s = await create({ protocol: 'socks5', host: '10.9.8.7', port: 1080, username: 'usr', password: 'segredo-proxy' })
    const qr = await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)
    expect(qr.status, qr.text).toBe(202)
    await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
    const opts = ctx.tf.last(s.id)!.lastConnect
    expect(opts.proxyUrl, 'transport.connect sem proxy (conexão direta)').toBeTruthy()
    const u = new URL(opts.proxyUrl)
    expect([u.protocol, u.hostname, u.port, decodeURIComponent(u.username), decodeURIComponent(u.password)]).toEqual(['socks5:', '10.9.8.7', '1080', 'usr', 'segredo-proxy'])
  })

  it('AC-T17-06 proxy indisponível: não conecta direto e a sessão não fica conectada', async () => {
    const s = await create({ protocol: 'http', host: '10.9.8.6', port: 3128 })
    sqlOk(ctx.tempDb.url, `UPDATE proxies SET available = false WHERE id = ${lit(s.proxy.id)};`)
    await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)
    await ctx.manager.whenIdle?.()
    const direct = ctx.tf.transports(s.id).flatMap((t: any) => t.connectCalls).filter((c: any) => !c.proxyUrl)
    expect(direct, 'fallback direto proibido').toEqual([])
    expect(ctx.tf.transports(s.id).flatMap((t: any) => t.connectCalls).length).toBe(0)
    expect(['NEW', 'DISCONNECTED']).toContain(statusOf(ctx, s.id))
  })

  it('AC-T17-06 depois do PATCH de proxy, o restart conecta pelo proxy novo e limpa requires_restart', async () => {
    const s = await create({ protocol: 'http', host: '10.9.8.5', port: 3128 })
    await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)
    await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
    await ctx.tf.last(s.id)!.login()
    await expect.poll(() => statusOf(ctx, s.id), { timeout: 5_000 }).toBe('WARMING')

    const p = await api(ctx, 'PATCH', `/api/sessions/${s.id}`, { proxy: { protocol: 'socks5', host: '10.9.8.4', port: 1081 } })
    expect(p.status, p.text).toBe(200)
    expect(p.body.requiresRestart).toBe(true)
    const r = await api(ctx, 'POST', `/api/sessions/${s.id}/restart`)
    expect(r.status, r.text).toBe(200)
    await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(2)
    const u = new URL(ctx.tf.last(s.id)!.lastConnect.proxyUrl)
    expect([u.protocol, u.hostname, u.port]).toEqual(['socks5:', '10.9.8.4', '1081'])
    await expect.poll(() => sqlOk(ctx.tempDb.url, `SELECT requires_restart FROM sessions WHERE id = ${lit(s.id)};`)[0]![0], { timeout: 5_000 }).toBe('f')
  })
})
