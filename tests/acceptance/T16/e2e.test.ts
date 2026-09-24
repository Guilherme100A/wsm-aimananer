// E2E contra a stack do docker compose (projeto isolado `wsm-e2e`). Um único arquivo porque a stack é
// cara (memória e tempo): o bloco AC-T16-01 sobe e mede, os blocos seguintes usam a stack viva, e o
// afterAll derruba tudo (down -v). Os blocos rodam em ordem (vitest executa os testes de um arquivo em série).
import { createHmac } from 'node:crypto'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHttpMock, type HttpMock } from '../helpers/mocks'
import { exec, tail } from '../helpers/exec'
import {
  api,
  compose,
  composeOk,
  connectSession,
  createContact,
  down,
  fake,
  http,
  jidOf,
  logs,
  messageStatus,
  ps,
  randomPhone,
  sendText,
  sentHistory,
  SERVICES,
  TOKENS,
  until,
  URLS,
  waitMessageStatus,
  waitSessionStatus,
} from './stack'

const UP_BUDGET_MS = 120_000
let stackUp = false
let hook: HttpMock
const HOOK_SECRET = `whsec-${randomBytes(8).toString('hex')}`

/** Aumenta os limites de taxa da sessão (os defaults conservadores seguram rajadas de teste). */
async function relaxLimits(id: string) {
  const r = await api('PUT', `/api/sessions/${id}/limits`, { perMinute: 1000, perHour: 1000, perDay: 1000 })
  expect(r.status, `PUT /limits → ${r.text}`).toBe(200)
}

/** Reinicia o worker e espera o novo boot (bootId diferente) e o serviço healthy. */
async function currentBootId(): Promise<string | undefined> {
  const r = await http(URLS.workerInternal, 'GET', '/internal/fake/boot', { token: TOKENS.internal, timeoutMs: 5_000 })
  return r.status === 200 ? r.body?.bootId : undefined
}

async function waitNewBoot(previous: string | undefined) {
  return until(currentBootId, (b) => !!b && b !== previous, { timeoutMs: 120_000, intervalMs: 500, what: 'novo boot do worker' })
}

async function reopenAfterBoot(sessionId: string) {
  // o worker reconecta sozinho (novo FakeTransport); o fake não abre sozinho: abrimos de novo
  const st = await until(() => fake('GET', sessionId, 'state'), (r) => r.status === 200 && r.body?.connectCalls >= 1, {
    timeoutMs: 60_000,
    what: `reconexão da sessão ${sessionId} no boot`,
  })
  expect(st.body.connectCalls).toBeGreaterThanOrEqual(1)
  const opened = await fake('POST', sessionId, 'open')
  expect(opened.status, `fake open → ${opened.text}`).toBeLessThan(300)
}

describe('T16 — integração E2E (docker compose)', () => {
  beforeAll(async () => {
    // imagens construídas fora da medição do AC-T16-01 (o build não conta no orçamento de subida)
    down()
    composeOk('build', { timeoutMs: 1_500_000 })
    hook = await startHttpMock('0.0.0.0')
  }, 1_600_000)

  afterAll(async () => {
    await hook?.close()
    const r = down()
    if (r.code !== 0) console.warn(`down falhou: ${tail(r)}`)
  }, 300_000)

  // ---- AC-T16-01 -------------------------------------------------------------------------------

  it('AC-T16-01 docker compose up -d --wait deixa os 5 serviços healthy em ≤ 120 s', async () => {
    const t0 = Date.now()
    const r = compose('up -d --wait --wait-timeout 180', { timeoutMs: 300_000 })
    const elapsed = Date.now() - t0
    stackUp = r.code === 0
    expect(r.code, `${tail(r, 60)}\n--- logs ---\n${logs()}`).toBe(0)
    expect(elapsed, `subida levou ${elapsed} ms`).toBeLessThanOrEqual(UP_BUDGET_MS)

    const entries = ps()
    for (const s of SERVICES) {
      const e = entries.find((x) => x.Service === s)
      expect(e, `serviço ${s} ausente no compose ps: ${JSON.stringify(entries)}`).toBeDefined()
      expect(e!.State, `${s}: ${JSON.stringify(e)}`).toBe('running')
      expect(e!.Health, `${s} deveria ter healthcheck e estar healthy: ${JSON.stringify(e)}`).toBe('healthy')
    }
    expect(entries.filter((e) => (SERVICES as readonly string[]).includes(e.Service))).toHaveLength(5)
  })

  it('AC-T16-01 endpoints de saúde respondem: api /health, worker /health e /metrics, dashboard / com proxy de /api', async () => {
    expect(stackUp, 'stack não subiu').toBe(true)
    expect((await http(URLS.api, 'GET', '/health')).status).toBe(200)
    expect((await http(URLS.workerHealth, 'GET', '/health')).status).toBe(200)
    const metrics = await fetch(`${URLS.workerHealth}/metrics`)
    expect(metrics.status).toBe(200)
    expect(await metrics.text()).toMatch(/^# (HELP|TYPE) /m)

    const page = await fetch(`${URLS.dashboard}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toMatch(/<div id="root"|<html/i)
    // o nginx do dashboard encaminha /api para a api (com o token do chamador)
    const viaDashboard = await http(URLS.dashboard, 'GET', '/api/sessions', { token: TOKENS.api })
    expect(viaDashboard.status, viaDashboard.text).toBe(200)
    const unauth = await http(URLS.dashboard, 'GET', '/api/sessions')
    expect(unauth.status).toBe(401)
  })

  // ---- AC-T16-02 -------------------------------------------------------------------------------

  it('AC-T16-02 fluxo completo com FakeTransport: sessão → QR → conectar → contato consentido → enviar → sent → delivered', async () => {
    expect(stackUp, 'stack não subiu').toBe(true)
    const { id } = await connectSession()
    const contact = await createContact()
    const text = `e2e-fluxo-${randomBytes(3).toString('hex')}`

    const res = await sendText(id, contact.phone, text)
    expect(res.status, res.text).toBe(202)
    expect(res.body.status).toBe('queued')
    const sent = await waitMessageStatus(res.body.id, 'sent')
    const transportId = sent.body.transportMessageId
    expect(transportId, 'mensagem sent sem transportMessageId').toBeTruthy()

    // chegou ao FakeTransport dentro do worker
    const state = await fake('GET', id, 'state')
    expect(state.status).toBe(200)
    const out = (state.body.sent as any[]).find((s) => s.content?.text === text)
    expect(out, `envio não chegou ao fake: ${state.text}`).toBeDefined()
    expect(out.to).toBe(jidOf(contact.phone))
    expect(out.messageId).toBe(transportId)

    const receipt = await fake('POST', id, 'receipt', { messageId: transportId, status: 'delivered' })
    expect(receipt.status, receipt.text).toBeLessThan(300)
    const delivered = await waitMessageStatus(res.body.id, 'delivered')
    expect(delivered.body.deliveredAt).toBeTruthy()

    const events = await api('GET', `/api/messages/${res.body.id}/events`)
    const seq = (events.body?.items ?? []).map((e: any) => e.toStatus ?? e.to_status ?? e.to)
    expect(seq).toEqual(expect.arrayContaining(['queued', 'processing', 'sent', 'delivered']))
  })

  it('AC-T16-02 a API conversa com o worker em outro container: estado, health e grupos vêm do worker', async () => {
    const { id } = await connectSession()
    const health = await api('GET', `/api/sessions/${id}/health`)
    expect(health.status, health.text).toBe(200)
    expect(health.body.state).toBe('WARMING')
    const setGroups = await fake('PUT', id, 'groups', { groups: [{ id: '120363000000000001@g.us', name: 'E2E', participants: 3, announce: false }] })
    expect(setGroups.status, setGroups.text).toBeLessThan(300)
    const groups = await api('GET', `/api/sessions/${id}/groups`)
    expect(groups.status, groups.text).toBe(200)
    expect(groups.body.items).toEqual([expect.objectContaining({ id: '120363000000000001@g.us', name: 'E2E', participants: 3 })])
  })

  it('AC-T16-02 o controle do fake exige o token interno (401) e sessão sem transporte vivo → 404', async () => {
    const created = await api('POST', '/api/sessions', { name: 'sem-conexao', phone: randomPhone() })
    expect(created.status).toBe(201)
    expect((await fake('GET', created.body.id, 'state', undefined, null)).status).toBe(401)
    expect((await fake('GET', created.body.id, 'state', undefined, 'token-errado')).status).toBe(401)
    const r = await fake('POST', created.body.id, 'open')
    expect(r.status, r.text).toBe(404)
    // a API pública não aceita o token interno, nem o controle interno aceita o token da API
    expect((await api('GET', '/api/sessions', undefined, TOKENS.internal)).status).toBe(401)
    expect((await fake('GET', created.body.id, 'state', undefined, TOKENS.api)).status).toBe(401)
  })

  it('AC-T16-02 com WA_TRANSPORT=baileys as rotas /internal/fake/* não existem (worker isolado, banco vazio, sem conectar ao WhatsApp)', async () => {
    expect(stackUp, 'stack não subiu').toBe(true)
    const db = `wsm_baileys_${randomBytes(3).toString('hex')}`
    composeOk(`exec -T postgres createdb -U wsm ${db}`, { timeoutMs: 60_000 })
    const name = `wsm-e2e-baileys-${randomBytes(3).toString('hex')}`
    const port = 19475
    try {
      composeOk(
        `run -d --no-deps --name ${name} -p ${port}:9465 -e WA_TRANSPORT=baileys -e ANTIBAN_MODE=real -e DATABASE_URL=postgres://wsm:wsm@postgres:5432/${db} worker`,
        { timeoutMs: 120_000 },
      )
      const base = `http://127.0.0.1:${port}`
      // espera o servidor interno responder (qualquer status HTTP)
      const probe = await until(
        () => http(base, 'GET', '/internal/fake/boot', { token: TOKENS.internal, timeoutMs: 3_000 }),
        (r) => typeof r.status === 'number',
        { timeoutMs: 90_000, intervalMs: 500, what: 'servidor interno do worker baileys' },
      )
      expect(probe.status, `/internal/fake/boot com baileys → ${probe.status} ${probe.text}`).toBe(404)
      for (const [method, path] of [
        ['GET', '/internal/fake/sessions/00000000-0000-4000-8000-000000000000/state'],
        ['POST', '/internal/fake/sessions/00000000-0000-4000-8000-000000000000/open'],
        ['POST', '/internal/fake/sessions/00000000-0000-4000-8000-000000000000/receive'],
        ['GET', '/internal/fake/sessions/00000000-0000-4000-8000-000000000000/sent-history'],
      ] as const) {
        const r = await http(base, method, path, { token: TOKENS.internal, body: method === 'POST' ? {} : undefined })
        expect(r.status, `${method} ${path} com baileys → ${r.status}`).toBe(404)
      }
    } finally {
      exec(`docker rm -f ${name}`, { timeoutMs: 60_000 })
      compose(`exec -T postgres dropdb -U wsm --if-exists ${db}`, { timeoutMs: 60_000 })
    }
  })

  // ---- AC-T16-03 -------------------------------------------------------------------------------

  it('AC-T16-03 fluxo de risco: 403 no envio → PAUSED → webhook de alerta recebido → envio seguinte rejeitado com SESSION_NOT_CONNECTED', async () => {
    expect(stackUp, 'stack não subiu').toBe(true)
    const wh = await api('POST', '/api/webhooks', {
      name: 'e2e-alertas',
      channel: 'http',
      url: `http://host.docker.internal:${hook.port}/alert`,
      secret: HOOK_SECRET,
    })
    expect(wh.status, `POST /api/webhooks → ${wh.text}`).toBe(201)

    const { id } = await connectSession()
    const contact = await createContact()
    const fail = await fake('POST', id, 'fail-next-send', { statusCode: 403, message: 'forbidden' })
    expect(fail.status, fail.text).toBeLessThan(300)
    const res = await sendText(id, contact.phone, `vai-dar-403-${randomBytes(2).toString('hex')}`)
    expect(res.status, res.text).toBe(202)

    await waitSessionStatus(id, 'PAUSED', 60_000)
    const alert = await until(
      async () => hook.on('/alert').find((r) => r.json?.sessionId === id && r.json?.event === 'forbidden_403'),
      (r) => !!r,
      { timeoutMs: 60_000, what: 'webhook forbidden_403 no servidor do host' },
    )
    const signature = createHmac('sha256', HOOK_SECRET).update(alert!.raw).digest('hex')
    expect(alert!.headers['x-wsm-signature'], 'assinatura HMAC do webhook').toBe(signature)

    const next = await sendText(id, contact.phone, 'depois do 403')
    expect(next.status, next.text).toBe(409)
    expect(next.body?.error?.code).toBe('SESSION_NOT_CONNECTED')
    expect((await api('GET', `/api/sessions/${id}/health`)).body.forbidden403).toBeGreaterThanOrEqual(1)
  })

  it('AC-T16-03 conexão fechada com 403 (close forbidden) também pausa, alerta e bloqueia envios', async () => {
    const { id } = await connectSession()
    const contact = await createContact()
    const closed = await fake('POST', id, 'close', { reason: 'forbidden', statusCode: 403 })
    expect(closed.status, closed.text).toBeLessThan(300)
    await waitSessionStatus(id, 'PAUSED', 60_000)
    await until(async () => hook.on('/alert').some((r) => r.json?.sessionId === id && r.json?.event === 'forbidden_403'), (v) => v, {
      timeoutMs: 60_000,
      what: 'webhook forbidden_403 (close)',
    })
    const next = await sendText(id, contact.phone, 'depois do close 403')
    expect(next.status, next.text).toBe(409)
    expect(next.body?.error?.code).toBe('SESSION_NOT_CONNECTED')
  })

  // ---- AC-T16-04 -------------------------------------------------------------------------------

  it('AC-T16-04 fluxo de opt-out: contato envia "SAIR" → opt_out=true → envio seguinte rejeitado com CONTACT_NOT_ALLOWED', async () => {
    expect(stackUp, 'stack não subiu').toBe(true)
    const { id } = await connectSession()
    const contact = await createContact()
    const first = await sendText(id, contact.phone, `antes-do-sair-${randomBytes(2).toString('hex')}`)
    expect(first.status, first.text).toBe(202)
    await waitMessageStatus(first.body.id, 'sent')

    const recv = await fake('POST', id, 'receive', { from: jidOf(contact.phone), text: 'SAIR' })
    expect(recv.status, recv.text).toBeLessThan(300)
    await until(() => api('GET', `/api/contacts/${contact.id}`), (r) => r.body?.opt_out === true || r.body?.optOut === true, {
      timeoutMs: 30_000,
      what: 'opt_out=true após SAIR',
    })

    const before = (await sentHistory(id)).length
    const next = await sendText(id, contact.phone, 'depois do SAIR')
    expect(next.status, next.text).toBe(403)
    expect(next.body?.error?.code).toBe('CONTACT_NOT_ALLOWED')
    expect((await sentHistory(id)).length, 'nada pode ser enviado ao contato que saiu').toBe(before)
  })

  it('AC-T16-04 mensagem comum do contato não gera opt-out (só o pedido de saída gera)', async () => {
    const { id } = await connectSession()
    const a = await createContact()
    const b = await createContact()
    expect((await fake('POST', id, 'receive', { from: jidOf(a.phone), text: 'oi, tudo bem? quero saber o preço' })).status).toBeLessThan(300)
    expect((await fake('POST', id, 'receive', { from: jidOf(b.phone), text: 'SAIR' })).status).toBeLessThan(300)
    // prova de que as mensagens recebidas já foram processadas: o SAIR (enviado depois) foi aplicado
    await until(() => api('GET', `/api/contacts/${b.id}`), (r) => r.body?.opt_out === true || r.body?.optOut === true, { timeoutMs: 30_000, what: 'opt-out de B' })
    const ca = await api('GET', `/api/contacts/${a.id}`)
    expect(ca.body.opt_out ?? ca.body.optOut).toBe(false)
    const res = await sendText(id, a.phone, `segue-${randomBytes(2).toString('hex')}`)
    expect(res.status, res.text).toBe(202)
  })

  // ---- AC-T16-05 -------------------------------------------------------------------------------

  it('AC-T16-05 docker compose restart worker no meio da fila: sessão reconecta, a fila retoma e cada mensagem é enviada exatamente uma vez', async () => {
    expect(stackUp, 'stack não subiu').toBe(true)
    const { id } = await connectSession()
    await relaxLimits(id)
    const contact = await createContact()
    expect((await fake('POST', id, 'send-delay', { ms: 800 })).status).toBeLessThan(300)

    const texts = Array.from({ length: 6 }, (_, i) => `restart-${i}-${randomBytes(3).toString('hex')}`)
    const ids: string[] = []
    for (const t of texts) {
      const r = await sendText(id, contact.phone, t)
      expect(r.status, r.text).toBe(202)
      ids.push(r.body.id)
    }
    // espera a fila estar no meio: ao menos 1 enviada e ao menos 1 ainda não
    await until(() => sentHistory(id), (h) => h.length >= 1, { timeoutMs: 30_000, what: 'primeiro envio antes do restart' })
    const sentBefore = (await sentHistory(id)).length
    expect(sentBefore, 'a fila terminou antes do restart; aumente o send-delay').toBeLessThan(texts.length)

    const boot0 = await currentBootId()
    composeOk('restart worker', { timeoutMs: 180_000 })
    await waitNewBoot(boot0)
    expect(await (async () => (await api('GET', `/api/sessions/${id}`)).body.status)()).toBe('WARMING')
    await reopenAfterBoot(id)

    for (const m of ids) await waitMessageStatus(m, 'sent', 90_000)
    const history = await sentHistory(id)
    for (const t of texts) {
      const n = history.filter((h) => h.content?.text === t).length
      expect(n, `"${t}" enviada ${n}x (esperado exatamente 1)\nhistórico: ${JSON.stringify(history)}`).toBe(1)
    }
    const boots = new Set(history.map((h) => h.bootId).filter(Boolean))
    expect(boots.size, 'a fila deveria ter continuado no novo boot').toBeGreaterThanOrEqual(2)
  })

  it('AC-T16-05 SIGKILL durante a espera antes do envio (sem marca de envio): mensagem volta para a fila e é enviada exatamente uma vez', async () => {
    const { id } = await connectSession()
    await relaxLimits(id)
    const contact = await createContact()
    expect((await fake('POST', id, 'hold-before-send', { ms: 60_000 })).status).toBeLessThan(300)
    const text = `kill-antes-${randomBytes(3).toString('hex')}`
    const queuedText = `kill-fila-${randomBytes(3).toString('hex')}`
    const r = await sendText(id, contact.phone, text)
    expect(r.status, r.text).toBe(202)
    const r2 = await sendText(id, contact.phone, queuedText)
    expect(r2.status, r2.text).toBe(202)
    await waitMessageStatus(r.body.id, 'processing', 30_000)

    const boot0 = await currentBootId()
    composeOk('kill -s SIGKILL worker', { timeoutMs: 60_000 })
    composeOk('up -d --wait worker', { timeoutMs: 180_000 })
    await waitNewBoot(boot0)
    await reopenAfterBoot(id)

    await waitMessageStatus(r.body.id, 'sent', 90_000)
    await waitMessageStatus(r2.body.id, 'sent', 90_000)
    const history = await sentHistory(id)
    expect(history.filter((h) => h.content?.text === text)).toHaveLength(1)
    expect(history.filter((h) => h.content?.text === queuedText)).toHaveLength(1)
  })

  it('AC-T16-05 SIGKILL durante o envio (com marca, sem messageId): failed "delivery state unknown", sem reenvio; o resto da fila segue uma vez', async () => {
    const { id } = await connectSession()
    await relaxLimits(id)
    const contact = await createContact()
    expect((await fake('POST', id, 'send-delay', { ms: 60_000 })).status).toBeLessThan(300)
    const text = `kill-durante-${randomBytes(3).toString('hex')}`
    const queuedText = `kill-depois-${randomBytes(3).toString('hex')}`
    const r = await sendText(id, contact.phone, text)
    expect(r.status, r.text).toBe(202)
    const r2 = await sendText(id, contact.phone, queuedText)
    expect(r2.status, r2.text).toBe(202)
    await waitMessageStatus(r.body.id, 'processing', 30_000)

    const boot0 = await currentBootId()
    composeOk('kill -s SIGKILL worker', { timeoutMs: 60_000 })
    composeOk('up -d --wait worker', { timeoutMs: 180_000 })
    await waitNewBoot(boot0)
    await reopenAfterBoot(id)

    const failed = await waitMessageStatus(r.body.id, 'failed', 90_000)
    expect(String(failed.body.error ?? failed.body.lastError ?? '')).toMatch(/delivery state unknown/i)
    await waitMessageStatus(r2.body.id, 'sent', 90_000)
    const history = await sentHistory(id)
    expect(history.filter((h) => h.content?.text === text).length, 'mensagem de estado incerto nunca é reenviada').toBeLessThanOrEqual(1)
    expect(history.filter((h) => h.content?.text === queuedText)).toHaveLength(1)
    // e continua failed (sem retry automático)
    expect(await messageStatus(r.body.id)).toBe('failed')
  })
})

