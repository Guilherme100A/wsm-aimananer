// AC-T15-03 — logs de worker e api em JSON, com session_id quando aplicável e redação de credenciais (T02).
import { describe, expect, it } from 'vitest'
import * as apiPkg from '@wsm/api'
import * as worker from '@wsm/worker'
import { capture, connectedSession, enqueue, pauseSession, useObservability, waitMsgStatus, type CapturedLogger } from './shared'

const SECRETS = ['SEGREDO-CREDS-7f3a', 'SEGREDO-TOKEN-91bc', 'SEGREDO-AUTH-44de', 'SEGREDO-KEY-0a1b']

function expectRedacted(log: CapturedLogger) {
  log.logger.info(
    {
      session_id: 'sessao-redacao',
      creds: { noiseKey: { private: SECRETS[0] } },
      token: SECRETS[1],
      authorization: `Bearer ${SECRETS[2]}`,
      nested: { deep: { signedIdentityKey: SECRETS[3] } },
    },
    'teste de redação',
  )
  const line = log.lines.find((l) => l.includes('teste de redação'))
  expect(line, 'linha de log não emitida').toBeTruthy()
  for (const s of SECRETS) expect(line!).not.toContain(s)
  const obj = JSON.parse(line!)
  expect(obj.session_id).toBe('sessao-redacao')
  expect(JSON.stringify(obj)).toMatch(/redacted/i)
}

describe('T15 — loggers de produto', () => {
  it('AC-T15-03 createApiLogger e createWorkerLogger emitem JSON com service e redigem credenciais', () => {
    const createApiLogger = (apiPkg as any).createApiLogger
    const createWorkerLogger = (worker as any).createWorkerLogger
    expect(typeof createApiLogger, '@wsm/api deve exportar createApiLogger').toBe('function')
    expect(typeof createWorkerLogger, '@wsm/worker deve exportar createWorkerLogger').toBe('function')

    const api = capture(createApiLogger)
    const wk = capture(createWorkerLogger)
    expectRedacted(api)
    expectRedacted(wk)
    expect(api.json().every((l) => l.service === 'api')).toBe(true)
    expect(wk.json().every((l) => l.service === 'worker')).toBe(true)
  })
})

describe('T15 — logs em uso', () => {
  const ctx = useObservability()

  it('AC-T15-03 logs do worker são JSON e as mudanças de estado da sessão levam session_id', async () => {
    const { id } = await connectedSession(ctx as any)
    const m = await enqueue(ctx as any, id)
    await waitMsgStatus(ctx as any, m.id, 'sent')
    await pauseSession(ctx as any, id)

    const lines = ctx.workerLog.json() // lança se alguma linha não for JSON
    expect(lines.length).toBeGreaterThan(0)
    const mine = lines.filter((l) => l.session_id === id)
    expect(mine.length, `nenhuma linha do worker com session_id=${id}`).toBeGreaterThan(0)
    expect(lines.every((l) => l.service === 'worker')).toBe(true)
    // mudança de estado (manager) e pausa da fila (queue) são logadas com o session_id
    expect(mine.some((l) => l.to === 'PAUSED' || /pause/i.test(String(l.msg)))).toBe(true)
  })

  it('AC-T15-03 logs da API são JSON, levam session_id em /api/sessions/:id e nunca expõem o token', async () => {
    const { id } = await connectedSession(ctx as any)
    const before = ctx.apiLog.lines.length
    const { call } = await import('../helpers/app')
    const res = await call(ctx.app, 'GET', `/api/sessions/${id}`, { token: ctx.token })
    expect(res.status).toBe(200)
    const r2 = await call(ctx.app, 'GET', `/api/messages?sessionId=${id}`, { token: ctx.token })
    expect(r2.status).toBe(200)

    const all = ctx.apiLog.json()
    expect(all.every((l) => l.service === 'api')).toBe(true)
    const fresh = all.slice(before)
    const forSession = fresh.filter((l) => JSON.stringify(l).includes(`/api/sessions/${id}`))
    expect(forSession.length, 'log da requisição GET /api/sessions/:id').toBeGreaterThan(0)
    expect(forSession.every((l) => l.session_id === id), JSON.stringify(forSession).slice(0, 500)).toBe(true)
    const forQuery = fresh.filter((l) => JSON.stringify(l).includes('/api/messages'))
    expect(forQuery.length, 'log da requisição GET /api/messages?sessionId=').toBeGreaterThan(0)
    expect(forQuery.some((l) => l.session_id === id)).toBe(true)

    for (const l of ctx.apiLog.lines) expect(l).not.toContain(ctx.token)
  })

  it('AC-T15-03 requisições sem sessão não inventam session_id', async () => {
    const before = ctx.apiLog.lines.length
    const { call } = await import('../helpers/app')
    await call(ctx.app, 'GET', '/health')
    const fresh = ctx.apiLog.json().slice(before)
    expect(fresh.length).toBeGreaterThan(0)
    for (const l of fresh) expect(l.session_id ?? null).toBeNull()
  })

  it('AC-T15-03 nenhum log de api ou worker contém material de credencial do WhatsApp', () => {
    const all = [...ctx.apiLog.lines, ...ctx.workerLog.lines]
    for (const l of all) {
      const lower = l.toLowerCase()
      for (const needle of ['"noisekey":{', '"signedidentitykey":{', '"advsecretkey":"', '"private":"', 'ciphertext":"'])
        expect(lower, `log expõe ${needle}: ${l.slice(0, 300)}`).not.toContain(needle)
    }
  })
})
