import { createProxy, loadProxyCore, proxyRow, proxyUrl, useApp } from './shared'
import { afterEach, describe, expect, it } from 'vitest'
import { call } from '../helpers/app'

describe('T06 — verificador periódico de proxies', () => {
  const ctx = useApp()
  const failing = new Map<string, string>()
  const probed: string[] = []
  const probe = async (proxy: { id: string }) => {
    probed.push(proxy.id)
    const err = failing.get(proxy.id)
    if (err) throw new Error(err)
  }
  let checker: any
  afterEach(() => {
    checker?.stop?.()
    checker = undefined
    failing.clear()
  })

  it('AC-T06-04 falha na checagem registra available=false, last_check_at, last_error, error_count e emite proxy_unavailable', async () => {
    const { createProxyChecker } = await loadProxyCore()
    const p = await createProxy(ctx, proxyUrl().url)
    failing.set(p.id, 'ECONNREFUSED proxy de teste')
    checker = createProxyChecker({ db: ctx.db, probe, intervalMs: 60_000 })
    const events: any[] = []
    checker.on('proxy_unavailable', (e: any) => events.push(e))
    const t0 = Date.now()

    await checker.checkAll()

    const r = proxyRow(ctx, p.id)
    expect(r.available).toBe(false)
    expect(r.last_check_at, 'last_check_at não registrado').toBeTruthy()
    expect(Date.parse(r.last_check_at)).toBeGreaterThanOrEqual(t0 - 5_000)
    expect(r.last_error).toContain('ECONNREFUSED')
    expect(r.error_count).toBe(1)

    const mine = events.filter((e) => e?.proxyId === p.id)
    expect(mine, `eventos: ${JSON.stringify(events)}`).toHaveLength(1)
    expect(mine[0].error).toBeTruthy()

    // a API reflete o estado
    const res = await call(ctx.app, 'GET', `/api/proxies/${p.id}`, { token: ctx.token })
    expect(res.body).toMatchObject({ available: false, errorCount: 1 })
    expect(res.body.lastCheckAt).toBeTruthy()
    expect(res.body.lastError).toContain('ECONNREFUSED')
  })

  it('AC-T06-04 falhas consecutivas incrementam o contador e emitem proxy_unavailable a cada checagem', async () => {
    const { createProxyChecker } = await loadProxyCore()
    const p = await createProxy(ctx, proxyUrl().url)
    failing.set(p.id, 'timeout')
    checker = createProxyChecker({ db: ctx.db, probe, intervalMs: 60_000 })
    const events: any[] = []
    checker.on('proxy_unavailable', (e: any) => events.push(e))
    await checker.checkAll()
    await checker.checkAll()
    await checker.checkAll()
    expect(proxyRow(ctx, p.id).error_count).toBe(3)
    expect(events.filter((e) => e?.proxyId === p.id)).toHaveLength(3)
  })

  it('AC-T06-04 checagem bem-sucedida registra available=true, last_check_at, limpa last_error e zera o contador; não emite evento', async () => {
    const { createProxyChecker } = await loadProxyCore()
    const p = await createProxy(ctx, proxyUrl().url)
    checker = createProxyChecker({ db: ctx.db, probe, intervalMs: 60_000 })
    const events: any[] = []
    checker.on('proxy_unavailable', (e: any) => events.push(e))

    failing.set(p.id, 'falha')
    await checker.checkAll()
    const firstCheck = proxyRow(ctx, p.id).last_check_at
    failing.delete(p.id)
    await new Promise((r) => setTimeout(r, 20))
    await checker.checkAll()

    const r = proxyRow(ctx, p.id)
    expect(r.available).toBe(true)
    expect(r.last_error).toBeNull()
    expect(r.error_count).toBe(0)
    expect(Date.parse(r.last_check_at)).toBeGreaterThan(Date.parse(firstCheck))
    expect(events.filter((e) => e?.proxyId === p.id)).toHaveLength(1)
  })

  it('AC-T06-04 o verificador roda periodicamente após start() e para após stop()', async () => {
    const { createProxyChecker } = await loadProxyCore()
    const p = await createProxy(ctx, proxyUrl().url)
    failing.set(p.id, 'down')
    checker = createProxyChecker({ db: ctx.db, probe, intervalMs: 100 })
    const events: any[] = []
    checker.on('proxy_unavailable', (e: any) => events.push(e))
    checker.start()
    await expect.poll(() => events.filter((e) => e?.proxyId === p.id).length, { timeout: 5_000, interval: 50 }).toBeGreaterThanOrEqual(2)
    checker.stop()
    await new Promise((r) => setTimeout(r, 300)) // deixa terminar uma checagem em curso
    const count = probed.length
    await new Promise((r) => setTimeout(r, 400))
    expect(probed.length, 'checagens continuaram após stop()').toBe(count)
    expect(proxyRow(ctx, p.id).error_count).toBeGreaterThanOrEqual(2)
  })
})
