// AC-T13-01 fluxo recebida → classificação → intenção → sugestão pending_approval (nada enviado sem aprovação)
// AC-T13-02 approve (texto opcionalmente editado) envia pelo SendPipeline; reject descarta
// AC-T13-04/05 cache e fallback no fluxo real · AC-T13-06 sugestão só a partir de mensagem recebida real
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { expectApiError } from '../helpers/http'
import { sql } from '../helpers/pg'
import {
  api,
  confident,
  connectedSession,
  createContact,
  inboundRows,
  outboundCount,
  pauseSession,
  randomPhone,
  receive,
  SMALL,
  suggestionCount,
  suggestions,
  uniq,
  useAi,
  waitMsgStatus,
} from './shared'

const VIEW_FIELDS = ['id', 'sessionId', 'inboundMessageId', 'phone', 'inboundText', 'intent', 'confidence', 'model', 'text', 'status', 'messageId', 'error', 'createdAt', 'updatedAt']

describe('T13 — fluxo da IA assistiva', () => {
  const ctx = useAi()

  it('AC-T13-01 mensagem recebida é persistida como inbound e vira sugestão pending_approval; nada é enviado', async () => {
    ctx.provider.behavior = confident
    const { id, t } = await connectedSession(ctx)
    const phone = randomPhone()
    const text = uniq('quanto custa')
    const msg = await receive(ctx, t, phone, text)

    const rows = inboundRows(ctx, id)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ phone, transportMessageId: msg.id })
    expect(JSON.stringify(rows[0]!.content)).toContain(text)

    const list = await suggestions(ctx, { sessionId: id })
    expect(list.length).toBe(1)
    const s = list[0]
    for (const f of VIEW_FIELDS) expect(s, `campo ${f}`).toHaveProperty(f)
    expect(s).toMatchObject({ sessionId: id, inboundMessageId: rows[0]!.id, phone, inboundText: text, intent: 'pricing', model: SMALL, status: 'pending_approval', messageId: null })
    expect(s.text).toContain(text)
    expect(ctx.provider.calls.at(-1)?.text).toBe(text)

    await new Promise((r) => setTimeout(r, 300))
    expect(outboundCount(ctx, id), 'nada pode ser enviado sem aprovação').toBe(0)
    expect(t.sendCalls.length).toBe(0)

    const one = await api(ctx, 'GET', `/api/suggestions/${s.id}`)
    expect(one.status, one.text).toBe(200)
    expect(one.body).toMatchObject({ id: s.id, status: 'pending_approval' })
    expect((await suggestions(ctx, { sessionId: id, status: 'pending_approval' })).map((x) => x.id)).toEqual([s.id])
    expect(await suggestions(ctx, { sessionId: id, status: 'sent' })).toEqual([])
  })

  it('AC-T13-01 opt-out tem prioridade: "SAIR" marca opt-out e não gera sugestão', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    const calls = ctx.provider.calls.length
    await receive(ctx, t, contact.phone, 'SAIR')
    expect(inboundRows(ctx, id).length, 'a mensagem recebida é persistida').toBe(1)
    expect(suggestionCount(ctx, id)).toBe(0)
    expect(ctx.provider.calls.length, 'provedor não deveria ser chamado').toBe(calls)
    const c = await api(ctx, 'GET', `/api/contacts/${contact.id}`)
    expect(c.body?.opt_out ?? c.body?.optOut).toBe(true)
  })

  it('AC-T13-01 sem autenticação a API de sugestões responde 401; inexistente → 404', async () => {
    expectApiError(await call(ctx.app, 'GET', '/api/suggestions'), 'UNAUTHORIZED', 401)
    expectApiError(await api(ctx, 'GET', `/api/suggestions/${randomUUID()}`), 'NOT_FOUND', 404)
    expectApiError(await api(ctx, 'POST', `/api/suggestions/${randomUUID()}/approve`, {}), 'NOT_FOUND', 404)
  })

  it('AC-T13-02 approve envia a sugestão pelo SendPipeline (fila → transporte) e marca sent', async () => {
    ctx.provider.behavior = confident
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await receive(ctx, t, contact.phone, uniq('olá'))
    const [s] = await suggestions(ctx, { sessionId: id })
    const res = await api(ctx, 'POST', `/api/suggestions/${s.id}/approve`, {})
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ id: s.id, status: 'sent' })
    expect(res.body.messageId).toBeTruthy()
    await waitMsgStatus(ctx, res.body.messageId, 'sent')
    expect(t.sent.map((m: any) => m.content?.text)).toEqual([s.text])
    expect(t.sent[0].to).toContain(contact.phone.replace(/^\+/, ''))
  })

  it('AC-T13-02 approve com texto editado envia o texto editado', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await receive(ctx, t, contact.phone, uniq('pergunta'))
    const [s] = await suggestions(ctx, { sessionId: id })
    const edited = uniq('texto revisado pelo humano')
    const res = await api(ctx, 'POST', `/api/suggestions/${s.id}/approve`, { text: edited })
    expect(res.status, res.text).toBe(200)
    await waitMsgStatus(ctx, res.body.messageId, 'sent')
    expect(t.sent.map((m: any) => m.content?.text)).toEqual([edited])
  })

  it('AC-T13-02 reject descarta: status rejected, nada enviado, e não pode mais ser aprovada', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await receive(ctx, t, contact.phone, uniq('oi'))
    const [s] = await suggestions(ctx, { sessionId: id })
    const res = await api(ctx, 'POST', `/api/suggestions/${s.id}/reject`, {})
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ id: s.id, status: 'rejected' })
    expectApiError(await api(ctx, 'POST', `/api/suggestions/${s.id}/approve`, {}), 'INVALID_TRANSITION', 409)
    await new Promise((r) => setTimeout(r, 300))
    expect(outboundCount(ctx, id)).toBe(0)
    expect(t.sent.length).toBe(0)
  })

  it('AC-T13-02 os gates valem: contato sem consentimento → 403 CONTACT_NOT_ALLOWED e sugestão failed', async () => {
    const { id, t } = await connectedSession(ctx)
    const phone = randomPhone() // sem contato/consentimento
    await receive(ctx, t, phone, uniq('olá'))
    const [s] = await suggestions(ctx, { sessionId: id })
    expectApiError(await api(ctx, 'POST', `/api/suggestions/${s.id}/approve`, {}), 'CONTACT_NOT_ALLOWED', 403)
    const after = await api(ctx, 'GET', `/api/suggestions/${s.id}`)
    expect(after.body).toMatchObject({ status: 'failed', error: 'CONTACT_NOT_ALLOWED' })
    expect(outboundCount(ctx, id)).toBe(0)
    expectApiError(await api(ctx, 'POST', `/api/suggestions/${s.id}/approve`, {}), 'INVALID_TRANSITION', 409)
  })

  it('AC-T13-02 os gates valem: sessão pausada → 409 SESSION_NOT_CONNECTED e sugestão failed', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await receive(ctx, t, contact.phone, uniq('olá'))
    const [s] = await suggestions(ctx, { sessionId: id })
    await pauseSession(ctx, id)
    expectApiError(await api(ctx, 'POST', `/api/suggestions/${s.id}/approve`, {}), 'SESSION_NOT_CONNECTED', 409)
    expect((await api(ctx, 'GET', `/api/suggestions/${s.id}`)).body).toMatchObject({ status: 'failed', error: 'SESSION_NOT_CONNECTED' })
  })

  it('AC-T13-04 no fluxo: mensagens com o mesmo texto normalizado chamam o provedor uma vez só', async () => {
    ctx.provider.behavior = confident
    const { id, t } = await connectedSession(ctx)
    const base = uniq('Qual O Endereço')
    const before = ctx.provider.calls.length
    await receive(ctx, t, randomPhone(), base)
    await receive(ctx, t, randomPhone(), `   ${base.toLowerCase()}   `)
    expect(ctx.provider.calls.length - before).toBe(1)
    const list = await suggestions(ctx, { sessionId: id })
    expect(list.length, 'cada mensagem recebida ganha sua sugestão').toBe(2)
    expect(new Set(list.map((s) => s.text)).size).toBe(1)
  })

  it('AC-T13-05 no fluxo: provedor com erro ainda gera sugestão pelo fallback, sem derrubar o worker', async () => {
    const { id, t } = await connectedSession(ctx)
    ctx.provider.behavior = async () => {
      throw new Error('falha do provedor')
    }
    try {
      await receive(ctx, t, randomPhone(), uniq('bom dia'))
      const [s] = await suggestions(ctx, { sessionId: id })
      expect(s).toMatchObject({ status: 'pending_approval', model: 'fallback' })
      expect(String(s.text).trim().length).toBeGreaterThan(0)
    } finally {
      ctx.provider.behavior = confident
    }
    await receive(ctx, t, randomPhone(), uniq('depois da falha'))
    expect(suggestionCount(ctx, id), 'worker segue processando').toBe(2)
  })

  it('AC-T13-06 sem mensagem recebida não há sugestão; mensagens próprias (fromMe), de grupo e repetidas não geram', async () => {
    const { id, t } = await connectedSession(ctx)
    await new Promise((r) => setTimeout(r, 500))
    await ctx.ai.idle()
    expect(suggestionCount(ctx, id), 'nenhuma sugestão espontânea').toBe(0)

    const before = ctx.provider.calls.length
    await receive(ctx, t, randomPhone(), uniq('eco'), { fromMe: true })
    t.receive({ from: '120363000000000001@g.us', text: uniq('grupo'), participant: `${randomPhone().slice(1)}@s.whatsapp.net` })
    await ctx.ai.idle()
    expect(suggestionCount(ctx, id)).toBe(0)
    expect(ctx.provider.calls.length).toBe(before)

    const m = await receive(ctx, t, randomPhone(), uniq('uma vez'))
    t.receive({ id: m.id, from: jidOf2(inboundRows(ctx, id)[0]!.phone), text: 'duplicada' })
    await ctx.ai.idle()
    expect(suggestionCount(ctx, id), 'mesmo msg.id não gera outra sugestão').toBe(1)
    expect(inboundRows(ctx, id).length).toBe(1)
  })

  it('AC-T13-06 toda sugestão aponta para uma mensagem inbound real (inbound_message_id obrigatório)', async () => {
    const orphan = sql(ctx.tempDb.url, `INSERT INTO suggestions (session_id, intent, confidence, model, text, status) SELECT id, 'other', 0.5, 'x', 'y', 'pending_approval' FROM sessions LIMIT 1;`)
    expect(orphan.code, 'insert sem inbound_message_id deveria falhar').not.toBe(0)
    const fake = sql(
      ctx.tempDb.url,
      `INSERT INTO suggestions (session_id, inbound_message_id, intent, confidence, model, text, status) SELECT id, '${randomUUID()}', 'other', 0.5, 'x', 'y', 'pending_approval' FROM sessions LIMIT 1;`,
    )
    expect(fake.code, 'inbound_message_id inexistente deveria violar a FK').not.toBe(0)
    const bad = sql(
      ctx.tempDb.url,
      `SELECT count(*) FROM suggestions s LEFT JOIN messages m ON m.id = s.inbound_message_id WHERE m.id IS NULL OR m.direction <> 'inbound';`,
    )
    expect(bad.rows[0]?.[0]).toBe('0')
  })
})

const jidOf2 = (phone: string) => `${phone.replace(/^\+/, '')}@s.whatsapp.net`
