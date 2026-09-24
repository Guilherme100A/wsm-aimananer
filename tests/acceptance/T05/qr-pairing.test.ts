import { api, createSession, sessionRow, statusOf, useSessions, waitStatus } from './shared'
import { describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { lit, sqlOk } from '../helpers/pg'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function expectPngDataUrl(value: unknown) {
  expect(typeof value, `qr deveria ser data URL, veio ${JSON.stringify(value)}`).toBe('string')
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value as string)
  expect(m, `formato inesperado: ${String(value).slice(0, 80)}`).toBeTruthy()
  const bytes = Buffer.from(m![1]!, 'base64')
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'data URL não contém um PNG').toBe(true)
  return bytes
}

describe('T05 — QR e código de pareamento', () => {
  const ctx = useSessions()

  it('AC-T05-02 POST /qr inicia a conexão pelo transportFactory (FakeTransport) e responde 202', async () => {
    const s = await createSession(ctx)
    const res = await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)
    expect(res.status, res.text).toBe(202)
    await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
    expect(ctx.tf.calls).toContain(s.id)
    const connect = ctx.tf.last(s.id)!.lastConnect
    expect(connect.sessionId).toBe(s.id)
    expect(connect.auth?.creds, 'connect precisa receber um AuthenticationState').toBeTruthy()
    expect(connect.pairingPhone, 'fluxo de QR não pede código de pareamento').toBeUndefined()
  })

  it('AC-T05-02 GET /qr devolve o QR mais recente como data URL PNG', async () => {
    const s = await createSession(ctx)
    expect((await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)).status).toBe(202)
    await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
    const t = ctx.tf.last(s.id)!

    t.emitQr('2@primeiro-qr-AAAA,BBBB,CCCC')
    let first: any
    await expect
      .poll(async () => {
        first = await api(ctx, 'GET', `/api/sessions/${s.id}/qr`)
        return first.body?.qr ?? null
      }, { timeout: 5_000 })
      .not.toBeNull()
    expect(first.status, first.text).toBe(200)
    const firstPng = expectPngDataUrl(first.body.qr)

    t.emitQr('2@segundo-qr-DDDD,EEEE,FFFF')
    let second: any
    await expect
      .poll(async () => {
        second = await api(ctx, 'GET', `/api/sessions/${s.id}/qr`)
        return second.body?.qr
      }, { timeout: 5_000 })
      .not.toBe(first.body.qr)
    expect(second.status).toBe(200)
    const secondPng = expectPngDataUrl(second.body.qr)
    expect(secondPng.equals(firstPng), 'GET /qr deveria trazer o QR mais recente').toBe(false)
    // o QR em si (conteúdo sensível de pareamento) não vaza em texto puro
    expect(second.text).not.toContain('segundo-qr-DDDD')
  })

  it('AC-T05-02 GET /qr antes de haver QR → 200 com qr null', async () => {
    const s = await createSession(ctx)
    const res = await api(ctx, 'GET', `/api/sessions/${s.id}/qr`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.qr ?? null).toBeNull()
  })

  it('AC-T05-02 POST /pairing-code conecta com pairingPhone e devolve o código emitido pelo transporte', async () => {
    const s = await createSession(ctx)
    const res = await api(ctx, 'POST', `/api/sessions/${s.id}/pairing-code`, {})
    expect(res.status, res.text).toBe(200)
    const t = ctx.tf.last(s.id)!
    expect(t, 'transportFactory não foi chamado').toBeDefined()
    expect(res.body.code).toBe(t.pairingCode)
    const pairingPhone = String(t.lastConnect.pairingPhone ?? '')
    expect(pairingPhone.replace(/\D/g, ''), 'pairingPhone deve ser o telefone da sessão').toBe(String(s.phone).replace(/\D/g, ''))
  })

  it('AC-T05-02 depois do QR, o login (open) leva a sessão para WARMING', async () => {
    const s = await createSession(ctx)
    expect((await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)).status).toBe(202)
    await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
    const t = ctx.tf.last(s.id)!
    t.emitQr()
    expect(statusOf(ctx, s.id)).toBe('NEW')
    await t.login()
    await waitStatus(ctx, s.id, 'WARMING')
  })

  it('AC-T05-02 sessão inexistente → 404 SESSION_NOT_FOUND em POST/GET /qr e /pairing-code', async () => {
    const id = '00000000-0000-4000-8000-000000000000'
    expectApiError(await api(ctx, 'POST', `/api/sessions/${id}/qr`), 'SESSION_NOT_FOUND', 404)
    expectApiError(await api(ctx, 'GET', `/api/sessions/${id}/qr`), 'SESSION_NOT_FOUND', 404)
    expectApiError(await api(ctx, 'POST', `/api/sessions/${id}/pairing-code`, {}), 'SESSION_NOT_FOUND', 404)
  })

  it('AC-T05-02 a conexão respeita o proxy da sessão (connectSession do T06): proxy disponível → connect com proxyUrl', async () => {
    const p = await api(ctx, 'POST', '/api/proxies', { url: `http://wsm:pw-${Date.now()}@10.254.9.9:${5000 + Math.floor(Math.random() * 1000)}` })
    expect(p.status, p.text).toBe(201)
    const s = await createSession(ctx, { proxyId: p.body.id })
    expect((await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)).status).toBe(202)
    await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
    expect(new URL(ctx.tf.last(s.id)!.lastConnect.proxyUrl).hostname).toBe('10.254.9.9')
  })

  it('AC-T05-02 proxy indisponível: não conecta direto (sem fallback) e a sessão fica DISCONNECTED', async () => {
    const p = await api(ctx, 'POST', '/api/proxies', { url: `http://wsm:pw-${Date.now()}@10.254.9.8:${6000 + Math.floor(Math.random() * 1000)}` })
    expect(p.status, p.text).toBe(201)
    const s = await createSession(ctx, { proxyId: p.body.id })
    sqlOk(ctx.tempDb.url, `UPDATE proxies SET available = false, last_error = 'ECONNREFUSED' WHERE id = ${lit(p.body.id)};`)
    await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)
    await waitStatus(ctx, s.id, 'DISCONNECTED')
    await new Promise((r) => setTimeout(r, 200))
    expect(ctx.tf.connectCount(s.id), 'conectou sem o proxy configurado').toBe(0)
    expect(sessionRow(ctx, s.id)!.proxy_id).toBe(p.body.id)
  })
})
