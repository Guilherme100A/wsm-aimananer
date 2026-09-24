// SuggestionService com Postgres local (banco descartável) e SendPipeline fake.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb, createTempDatabase, messages, sessions, suggestions, type Database, type TempDatabase } from '@wsm/db'
import { SendRejectedError, type SendRequest } from '../send/pipeline'
import type { IncomingMessage } from '../transport'
import { INBOUND_MESSAGE_STATUS, SuggestionError, SuggestionService } from './suggestions'

let tmp: TempDatabase
let db: Database
let svc: SuggestionService
let sessionId: string

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_ai' })
  db = createDb(tmp.url, { max: 4 })
  svc = new SuggestionService(db)
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

beforeEach(async () => {
  await db.delete(sessions)
  const [s] = await db.insert(sessions).values({ name: 's', phone: '+5511999990001', status: 'STABLE' }).returning()
  sessionId = s!.id
})

let seq = 0
const incoming = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: `WA-${++seq}`,
  from: '5511988887777@s.whatsapp.net',
  fromMe: false,
  timestamp: Date.now(),
  type: 'conversation',
  text: 'quanto custa?',
  ...over,
})
const ai = { intent: 'pricing', confidence: 0.8, model: 'small-m', text: 'Vou verificar os valores.' }

function fakePipeline(result: 'ok' | SendRejectedError) {
  const calls: SendRequest[] = []
  return {
    calls,
    pipeline: {
      send: async (req: SendRequest) => {
        calls.push(req)
        if (result !== 'ok') throw result
        const [m] = await db
          .insert(messages)
          .values({ sessionId: req.sessionId, phone: req.phone, content: req.content, status: 'queued' })
          .returning()
        return { id: m!.id } as never
      },
    },
  }
}

async function pending() {
  const rec = (await svc.recordInbound(sessionId, incoming()))!
  return svc.create(rec.message, ai)
}

describe('recordInbound', () => {
  it('persiste com direction inbound, telefone E.164 e transport id; sem duplicar', async () => {
    const msg = incoming({ text: 'oi', pushName: 'Ana' })
    const r = await svc.recordInbound(sessionId, msg)
    expect(r?.created).toBe(true)
    expect(r!.message).toMatchObject({
      direction: 'inbound',
      phone: '+5511988887777',
      status: INBOUND_MESSAGE_STATUS,
      transportMessageId: msg.id,
      content: { text: 'oi', type: 'conversation', pushName: 'Ana' },
      sentAt: null,
    })
    const again = await svc.recordInbound(sessionId, msg)
    expect(again).toMatchObject({ created: false, message: { id: r!.message.id } })
    expect(await db.select().from(messages)).toHaveLength(1)
  })

  it('ignora mensagens próprias e remetentes sem telefone (grupo)', async () => {
    expect(await svc.recordInbound(sessionId, incoming({ fromMe: true }))).toBeNull()
    expect(await svc.recordInbound(sessionId, incoming({ from: '120363000000000000@g.us' }))).toBeNull()
    expect(await db.select().from(messages)).toHaveLength(0)
  })
})

describe('sugestões', () => {
  it('create grava pending_approval ligada à mensagem recebida (uma por mensagem)', async () => {
    const rec = (await svc.recordInbound(sessionId, incoming()))!
    const s = await svc.create(rec.message, ai)
    expect(s).toMatchObject({
      sessionId,
      inboundMessageId: rec.message.id,
      phone: '+5511988887777',
      inboundText: 'quanto custa?',
      ...ai,
      status: 'pending_approval',
      messageId: null,
      error: null,
    })
    expect((await svc.create(rec.message, { ...ai, text: 'outra' })).id).toBe(s.id)
    expect(await svc.count(sessionId)).toBe(1)
  })

  it('só aceita mensagem inbound', async () => {
    const [out] = await db.insert(messages).values({ sessionId, phone: '+5511988887777', content: { text: 'x' } }).returning()
    await expect(svc.create(out!, ai)).rejects.toBeInstanceOf(SuggestionError)
  })

  it('list filtra por sessão e status; get devolve a view; id inválido → NOT_FOUND', async () => {
    const s = await pending()
    expect((await svc.list({ sessionId })).map((x) => x.id)).toEqual([s.id])
    expect(await svc.list({ status: 'sent' })).toEqual([])
    expect(await svc.list({ sessionId: 'nope' })).toEqual([])
    expect(await svc.get(s.id)).toEqual(s)
    await expect(svc.get('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(svc.get('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('approve envia pelo pipeline (texto editado) e fica sent com messageId', async () => {
    const s = await pending()
    const { pipeline, calls } = fakePipeline('ok')
    const r = await svc.approve(s.id, { actor: 'api_token', text: '  Olá! O plano custa R$ 10.  ', pipeline })
    expect(calls).toEqual([{ sessionId, phone: '+5511988887777', content: { text: 'Olá! O plano custa R$ 10.' }, actor: 'api_token' }])
    expect(r).toMatchObject({ status: 'sent', text: 'Olá! O plano custa R$ 10.', decidedBy: 'api_token', error: null })
    expect(r.messageId).toMatch(/^[0-9a-f-]{36}$/)
    await expect(svc.approve(s.id, { actor: 'x', pipeline })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    await expect(svc.reject(s.id, 'x')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    expect(calls).toHaveLength(1)
  })

  it('approve sem texto usa o sugerido; texto vazio é inválido', async () => {
    const s = await pending()
    const { pipeline, calls } = fakePipeline('ok')
    await expect(svc.approve(s.id, { actor: 'a', text: '   ', pipeline })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await svc.approve(s.id, { actor: 'a', pipeline })
    expect(calls[0]!.content).toEqual({ text: ai.text })
  })

  it('rejeição de gate: status failed com o código e o erro é relançado', async () => {
    const s = await pending()
    const { pipeline } = fakePipeline(new SendRejectedError('CONTACT_NOT_ALLOWED', 'no consent'))
    await expect(svc.approve(s.id, { actor: 'a', pipeline })).rejects.toBeInstanceOf(SendRejectedError)
    expect(await svc.get(s.id)).toMatchObject({ status: 'failed', error: 'CONTACT_NOT_ALLOWED', messageId: null })
    await expect(svc.approve(s.id, { actor: 'a', pipeline })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
  })

  it('reject descarta sem enviar', async () => {
    const s = await pending()
    const r = await svc.reject(s.id, 'api_token')
    expect(r).toMatchObject({ status: 'rejected', decidedBy: 'api_token' })
    const [row] = await db.select().from(suggestions).where(eq(suggestions.id, s.id))
    expect(row!.sentMessageId).toBeNull()
    expect(await db.select().from(messages).where(eq(messages.direction, 'outbound'))).toHaveLength(0)
  })

  it('approve concorrente envia uma vez só', async () => {
    const s = await pending()
    const { pipeline, calls } = fakePipeline('ok')
    const results = await Promise.allSettled([svc.approve(s.id, { actor: 'a', pipeline }), svc.approve(s.id, { actor: 'b', pipeline })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })
})
