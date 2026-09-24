import { api, connectedSession, createSession, credentialCount, delay, statusOf, useSessions, waitStatus } from './shared'
import { describe, expect, it } from 'vitest'
import { lit, sqlOk } from '../helpers/pg'

describe('T05 — reconexão automática ao reiniciar o worker', () => {
  const ctx = useSessions()
  const setStatus = (id: string, status: string) => sqlOk(ctx.tempDb.url, `UPDATE sessions SET status = ${lit(status)} WHERE id = ${lit(id)};`)

  it('AC-T05-04 sessão WARMING com credenciais reconecta sozinha após restart, com as mesmas credenciais e sem novo QR', async () => {
    const { id, transport } = await connectedSession(ctx)
    await expect.poll(() => credentialCount(ctx, id), { timeout: 5_000 }).toBeGreaterThan(0)
    const noise = Buffer.from(transport.lastConnect.auth.creds.noiseKey.public)

    await ctx.restart()

    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000, message: 'sessão não reconectou no boot' }).toBe(1)
    const again = ctx.tf.last(id)!
    expect(again).not.toBe(transport)
    expect(again.lastConnect.pairingPhone).toBeUndefined()
    expect(Buffer.from(again.lastConnect.auth.creds.noiseKey.public).equals(noise), 'boot deveria reusar as credenciais persistidas').toBe(true)
    expect(statusOf(ctx, id), 'restart não pode mudar o estado').toBe('WARMING')

    await again.login()
    await delay(100)
    expect(statusOf(ctx, id)).toBe('WARMING')
  })

  it('AC-T05-04 sessão STABLE com credenciais reconecta e continua STABLE', async () => {
    const { id } = await connectedSession(ctx)
    await expect.poll(() => credentialCount(ctx, id), { timeout: 5_000 }).toBeGreaterThan(0)
    await ctx.stop()
    setStatus(id, 'STABLE')

    await ctx.restart()
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(1)
    await ctx.tf.last(id)!.login()
    await delay(150)
    expect(statusOf(ctx, id)).toBe('STABLE')
  })

  it('AC-T05-04 sessão PAUSED reconecta após restart mas continua PAUSED', async () => {
    const { id } = await connectedSession(ctx)
    await expect.poll(() => credentialCount(ctx, id), { timeout: 5_000 }).toBeGreaterThan(0)
    const pause = await api(ctx, 'POST', `/api/sessions/${id}/pause`)
    expect(pause.status, pause.text).toBe(200)
    await waitStatus(ctx, id, 'PAUSED')

    await ctx.restart()
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000, message: 'sessão PAUSED também deve reconectar' }).toBe(1)
    expect(statusOf(ctx, id)).toBe('PAUSED')
    await ctx.tf.last(id)!.login()
    await delay(150)
    expect(statusOf(ctx, id), 'abrir a conexão não pode tirar a sessão de PAUSED').toBe('PAUSED')
    const get = await api(ctx, 'GET', `/api/sessions/${id}`)
    expect(get.body.status).toBe('PAUSED')
  })

  it('AC-T05-04 sessão DISCONNECTED (mesmo com credenciais) não reconecta no boot', async () => {
    const { id } = await connectedSession(ctx)
    await expect.poll(() => credentialCount(ctx, id), { timeout: 5_000 }).toBeGreaterThan(0)
    await ctx.stop()
    setStatus(id, 'DISCONNECTED')

    await ctx.restart()
    await delay(300)
    expect(ctx.tf.connectCount(id)).toBe(0)
    expect(statusOf(ctx, id)).toBe('DISCONNECTED')
  })

  it('AC-T05-04 sessão sem credenciais (NEW, nunca autenticada) não reconecta no boot', async () => {
    const s = await createSession(ctx)
    expect(credentialCount(ctx, s.id)).toBe(0)
    await ctx.restart()
    await delay(300)
    expect(ctx.tf.connectCount(s.id)).toBe(0)
    expect(statusOf(ctx, s.id)).toBe('NEW')
  })

  it('AC-T05-04 após o restart, a sessão reconectada volta a ser controlável pela API (pause funciona)', async () => {
    const { id } = await connectedSession(ctx)
    await expect.poll(() => credentialCount(ctx, id), { timeout: 5_000 }).toBeGreaterThan(0)
    await ctx.restart()
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(1)
    await ctx.tf.last(id)!.login()
    const pause = await api(ctx, 'POST', `/api/sessions/${id}/pause`)
    expect(pause.status, pause.text).toBe(200)
    expect(pause.body.status).toBe('PAUSED')
  })
})
