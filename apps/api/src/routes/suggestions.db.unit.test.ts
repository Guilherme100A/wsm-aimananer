// /api/suggestions com Postgres local (banco descartável) e SendPipeline fake.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { SendRejectedError, SuggestionService, type SendRequest } from '@wsm/core'
import { auditLogs, createDb, createTempDatabase, messages, sessions, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'

const TOKEN = 'sg-token'
let tmp: TempDatabase
let db: Database
let sessionId: string
let sends: SendRequest[]
let reject: SendRejectedError | undefined

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_suggestions' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

beforeEach(async () => {
  await db.delete(sessions)
  await db.delete(auditLogs)
  sends = []
  reject = undefined
  const [s] = await db.insert(sessions).values({ name: 's', phone: '+5511999990001', status: 'STABLE' }).returning()
  sessionId = s!.id
})

const pipeline = {
  send: async (req: SendRequest) => {
    sends.push(req)
    if (reject) throw reject
    const [m] = await db.insert(messages).values({ sessionId: req.sessionId, phone: req.phone, content: req.content, status: 'queued' }).returning()
    return { id: m!.id } as never
  },
}

function api() {
  const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN, pipeline })
  return (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    app.request(path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
}

let seq = 0
async function pending(text = 'quanto custa?') {
  const svc = new SuggestionService(db)
  const rec = (await svc.recordInbound(sessionId, {
    id: `WA-${++seq}`,
    from: '5511988887777@s.whatsapp.net',
    fromMe: false,
    timestamp: Date.now(),
    type: 'conversation',
    text,
  }))!
  return svc.create(rec.message, { intent: 'pricing', confidence: 0.8, model: 'small-m', text: 'Vou verificar.' })
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code

describe('/api/suggestions', () => {
  it('lista por sessão/status e busca por id', async () => {
    const s = await pending()
    const req = api()
    const list = (await (await req('GET', `/api/suggestions?sessionId=${sessionId}&status=pending_approval`)).json()) as { items: Array<{ id: string }> }
    expect(list.items.map((i) => i.id)).toEqual([s.id])
    expect(((await (await req('GET', '/api/suggestions?status=sent')).json()) as { items: unknown[] }).items).toEqual([])
    const one = await req('GET', `/api/suggestions/${s.id}`)
    expect(one.status).toBe(200)
    expect(await one.json()).toMatchObject({ id: s.id, phone: '+5511988887777', inboundText: 'quanto custa?', status: 'pending_approval' })
    expect((await req('GET', '/api/suggestions?status=banana')).status).toBe(400)
  })

  it('approve com texto editado envia pelo pipeline → 200 sent; auditado', async () => {
    const s = await pending()
    const res = await api()('POST', `/api/suggestions/${s.id}/approve`, { text: 'Custa R$ 10.' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; messageId: string; text: string }
    expect(body).toMatchObject({ status: 'sent', text: 'Custa R$ 10.' })
    expect(sends).toEqual([{ sessionId, phone: '+5511988887777', content: { text: 'Custa R$ 10.' }, actor: 'api_token' }])
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'suggestion.approve'))
    expect(audit).toMatchObject({ targetType: 'suggestion', targetId: s.id })
    const again = await api()('POST', `/api/suggestions/${s.id}/approve`)
    expect(again.status).toBe(409)
    expect(await code(again)).toBe('INVALID_TRANSITION')
  })

  it('approve sem corpo usa o texto sugerido', async () => {
    const s = await pending()
    expect((await api()('POST', `/api/suggestions/${s.id}/approve`)).status).toBe(200)
    expect(sends[0]!.content).toEqual({ text: 'Vou verificar.' })
  })

  it('rejeição de gate: resposta com o erro do gate e sugestão failed', async () => {
    const s = await pending()
    reject = new SendRejectedError('CONTACT_NOT_ALLOWED', 'contact has no consent')
    const res = await api()('POST', `/api/suggestions/${s.id}/approve`)
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('CONTACT_NOT_ALLOWED')
    expect(await (await api()('GET', `/api/suggestions/${s.id}`)).json()).toMatchObject({ status: 'failed', error: 'CONTACT_NOT_ALLOWED' })
  })

  it('reject → 200 rejected, nada enviado, auditado; depois 409', async () => {
    const s = await pending()
    const res = await api()('POST', `/api/suggestions/${s.id}/reject`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'rejected' })
    expect(sends).toEqual([])
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, 'suggestion.reject'))).toHaveLength(1)
    expect((await api()('POST', `/api/suggestions/${s.id}/reject`)).status).toBe(409)
  })

  it('404 NOT_FOUND, 400 para corpo inválido e 401 sem token', async () => {
    const s = await pending()
    const req = api()
    for (const id of ['00000000-0000-4000-8000-000000000000', 'nope']) {
      const r = await req('GET', `/api/suggestions/${id}`)
      expect(r.status).toBe(404)
      expect(await code(r)).toBe('NOT_FOUND')
      expect((await req('POST', `/api/suggestions/${id}/approve`)).status).toBe(404)
      expect((await req('POST', `/api/suggestions/${id}/reject`)).status).toBe(404)
    }
    expect((await req('POST', `/api/suggestions/${s.id}/approve`, '{bad')).status).toBe(400)
    expect((await req('POST', `/api/suggestions/${s.id}/approve`, { text: '' })).status).toBe(400)
    expect((await req('GET', '/api/suggestions', undefined, null)).status).toBe(401)
    expect(sends).toEqual([])
  })
})
