import { C, connectedSession, createContact, forbiddenError, send, spyAdapter, useQueue, waitMsgStatus } from './shared'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

describe('T09 — AntibanAdapter: modo, contrato e deliver', () => {
  const ctx = useQueue()

  // ---- modo (decisão do Orquestrador: ANTIBAN_MODE explícito, default real) -------------------

  it('AC-T09-03 sem ANTIBAN_MODE o modo é real (NODE_ENV/VITEST não desligam o antiban)', () => {
    expect(C.antibanModeFromEnv({})).toBe('real')
    expect(C.antibanModeFromEnv({ ANTIBAN_MODE: '' })).toBe('real')
    expect(C.antibanModeFromEnv({ NODE_ENV: 'test', VITEST: 'true' })).toBe('real')
    expect(C.antibanModeFromEnv({ NODE_ENV: 'development' })).toBe('real')
    expect(C.antibanModeFromEnv({ ANTIBAN_MODE: 'passthrough' })).toBe('passthrough')
    expect(C.antibanModeFromEnv({ ANTIBAN_MODE: 'real' })).toBe('real')
  })

  it('AC-T09-03 ANTIBAN_MODE inválido falha alto (AntibanConfigError), nunca desliga sozinho', () => {
    expect(() => C.antibanModeFromEnv({ ANTIBAN_MODE: 'off' })).toThrow(C.AntibanConfigError)
    expect(() => C.createAntibanAdapter({ env: { ANTIBAN_PRESET: 'inexistente' } })).toThrow(C.AntibanConfigError)
  })

  it('AC-T09-03 createAntibanAdapter sem configuração cria adapter real; passthrough só quando pedido, com warn', () => {
    const real = C.createAntibanAdapter({ env: {} })
    expect(real.mode).toBe('real')
    const warns: unknown[][] = []
    const logger = { warn: (...a: unknown[]) => warns.push(a), info: () => {}, debug: () => {}, error: () => {}, trace: () => {}, child: () => logger }
    const pt = C.createAntibanAdapter({ env: { ANTIBAN_MODE: 'passthrough' }, logger })
    expect(pt.mode).toBe('passthrough')
    expect(JSON.stringify(warns), 'passthrough deve avisar no log').toMatch(/passthrough/i)
  })

  it('AC-T09-03 esta suíte roda com ANTIBAN_MODE=passthrough explícito e o adapter padrão respeita isso', () => {
    expect(process.env.ANTIBAN_MODE).toBe('passthrough')
    C.resetDefaultAntibanAdapter()
    expect(C.defaultAntibanAdapter().mode).toBe('passthrough')
  })

  // ---- deliver: todo envio efetivo passa pelo adapter -------------------------------------------

  it('AC-T09-03 core.deliver (padrão, usado pela fila) passa pelo adapter padrão: beforeSend e afterSend contados por sessão', async () => {
    C.resetDefaultAntibanAdapter()
    const { id } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const res = await send(ctx, id, contact.phone)
    expect(res.status, res.text).toBe(202)
    await waitMsgStatus(ctx, res.body.id, 'sent')
    const stats = C.defaultAntibanAdapter().stats(id)
    expect(stats.before, `stats: ${JSON.stringify(stats)}`).toBeGreaterThanOrEqual(1)
    expect(stats.sent).toBeGreaterThanOrEqual(1)
  })

  it('AC-T09-03 createDeliver: beforeSend antes do envio, espera delayMs pelo sleep injetado, afterSend com o messageId', async () => {
    const { id, t } = await connectedSession(ctx)
    const order: string[] = []
    const adapter = spyAdapter(() => (order.push('beforeSend'), { allowed: true, delayMs: 1234 }))
    const sleeps: number[] = []
    const origSend = t.sendMessage.bind(t)
    t.sendMessage = async (to: string, content: any) => (order.push('sendMessage'), origSend(to, content))
    const deliver = C.createDeliver({ antiban: adapter, sleep: async (ms: number) => void (order.push('sleep'), sleeps.push(ms)) })

    const text = `d-${randomBytes(2).toString('hex')}`
    const r = await deliver(t, '5511999990000@s.whatsapp.net', { text })
    expect(order).toEqual(['beforeSend', 'sleep', 'sendMessage'])
    expect(sleeps).toEqual([1234])
    const before = adapter.calls.find((c) => c.fn === 'beforeSend')!
    expect(before.args[0], 'key do adapter = sessionId').toBe(id)
    expect(before.args[1]).toBe('5511999990000@s.whatsapp.net')
    const after = adapter.calls.find((c) => c.fn === 'afterSend')!
    expect(after.args[0]).toBe(id)
    expect(after.args[3]).toBe(r.messageId)
    expect(t.sent.at(-1).content.text).toBe(text)
  })

  it('AC-T09-03 adapter nega (allowed=false) → nada chega ao transporte e o deliver lança AntibanBlockedError', async () => {
    const { t } = await connectedSession(ctx)
    const adapter = spyAdapter(() => ({ allowed: false, delayMs: 0, reason: 'identical message' }))
    const deliver = C.createDeliver({ antiban: adapter, sleep: async () => {} })
    const err = await deliver(t, '5511999990001@s.whatsapp.net', { text: 'bloqueada' }).then(
      () => undefined,
      (e: any) => e,
    )
    expect(err).toBeInstanceOf(C.AntibanBlockedError)
    expect(err.code).toBe('ANTIBAN_BLOCKED')
    expect(t.sent).toHaveLength(0)
    expect(adapter.calls.filter((c) => c.fn === 'afterSend')).toHaveLength(0)
  })

  it('AC-T09-03 falha comum no envio → afterSendFailed e o erro é relançado (a fila decide o retry)', async () => {
    const { id, t } = await connectedSession(ctx)
    const adapter = spyAdapter()
    const signals: any[] = []
    const deliver = C.createDeliver({ antiban: adapter, sleep: async () => {}, health: { recordSignal: async (...a: any[]) => void signals.push(a) } })
    t.failNextSend(new Error('timeout'))
    await expect(deliver(t, '5511999990002@s.whatsapp.net', { text: 'x' })).rejects.toThrow('timeout')
    const failed = adapter.calls.find((c) => c.fn === 'afterSendFailed')
    expect(failed?.args[0]).toBe(id)
    expect(signals, 'falha comum não é 403').toHaveLength(0)
  })

  it('AC-T09-03 403 no envio → health.recordSignal(sessionId, "forbidden_403"), limits.reduce e erro relançado', async () => {
    const { id, t } = await connectedSession(ctx)
    const signals: any[] = []
    const reductions: any[] = []
    const deliver = C.createDeliver({
      antiban: spyAdapter(),
      sleep: async () => {},
      health: { recordSignal: async (...a: any[]) => void signals.push(a) },
      limits: { reduce: async (...a: any[]) => void reductions.push(a) },
    })
    t.failNextSend(forbiddenError())
    await expect(deliver(t, '5511999990003@s.whatsapp.net', { text: 'x' })).rejects.toBeDefined()
    expect(signals.map((s) => [s[0], s[1]])).toEqual([[id, 'forbidden_403']])
    expect(reductions).toHaveLength(1)
    expect(reductions[0][0]).toBe(id)
    expect(reductions[0][1]).toBeLessThan(1)
  })

  // ---- modo real: baileys-antiban de verdade, com sleep injetado ----------------------------------

  it('AC-T09-03 modo real (baileys-antiban conservative): impõe delay antes do envio', async () => {
    const { id, t } = await connectedSession(ctx)
    const adapter = C.createAntibanAdapter({ env: {}, mode: 'real' })
    expect(adapter.mode).toBe('real')
    const sleeps: number[] = []
    const deliver = C.createDeliver({ antiban: adapter, sleep: async (ms: number) => void sleeps.push(ms) })
    await deliver(t, '5511999990010@s.whatsapp.net', { text: `primeira ${randomBytes(2).toString('hex')}` })
    await deliver(t, '5511999990010@s.whatsapp.net', { text: `segunda ${randomBytes(2).toString('hex')}` })
    expect(sleeps.length).toBe(2)
    expect(Math.max(...sleeps), `delays do antiban real: ${JSON.stringify(sleeps)}`).toBeGreaterThan(0)
    const stats = adapter.stats(id)
    expect(stats.sent).toBe(2)
  })

  it('AC-T09-03 modo real: mensagens idênticas/volume em rajada acabam bloqueadas pelo baileys-antiban (sem esperar de verdade)', async () => {
    const { id, t } = await connectedSession(ctx)
    const adapter = C.createAntibanAdapter({ env: {}, mode: 'real' })
    const deliver = C.createDeliver({ antiban: adapter, sleep: async () => {} })
    let blocked: any
    for (let i = 0; i < 25 && !blocked; i++) {
      try {
        await deliver(t, '5511999990011@s.whatsapp.net', { text: 'mensagem identica repetida' })
      } catch (e) {
        blocked = e
      }
    }
    expect(blocked, 'o antiban real deveria bloquear a rajada de mensagens idênticas').toBeInstanceOf(C.AntibanBlockedError)
    expect(t.sent.length).toBeLessThan(25)
    expect(adapter.stats(id).blocked).toBeGreaterThanOrEqual(1)
  })

  it('AC-T09-03 modo real: estado do antiban é por sessão (bloqueio de uma não afeta outra)', async () => {
    const a = await connectedSession(ctx)
    const b = await connectedSession(ctx)
    const adapter = C.createAntibanAdapter({ env: {}, mode: 'real' })
    const deliver = C.createDeliver({ antiban: adapter, sleep: async () => {} })
    for (let i = 0; i < 25; i++) {
      try {
        await deliver(a.t, '5511999990012@s.whatsapp.net', { text: 'repetida' })
      } catch {
        break
      }
    }
    expect(adapter.stats(a.id).blocked).toBeGreaterThanOrEqual(1)
    await deliver(b.t, '5511999990013@s.whatsapp.net', { text: 'outra sessão' })
    expect(b.t.sent).toHaveLength(1)
    expect(adapter.stats(b.id).blocked).toBe(0)
  })
})
