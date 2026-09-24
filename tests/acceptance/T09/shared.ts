// Setup comum do T09: reaproveita o setup do T08 (banco descartável + Redis + SessionManager com
// FakeTransport + MessageQueue + createApp no mesmo processo). O POST /api/sessions/:id/messages monta
// o SendPipeline a partir de deps (sessions = SessionManager, messages = MessageQueue).
// Contrato combinado com o Operário (Brasa):
//   @wsm/core: GATE_ORDER · SendPipeline({ db, getTransport, queue, limits?, now?, schedule?, gates? })
//              .send(req) / .runGates(req) · SendRejectedError(code, message) { code, gate, status }
//              SessionLimitsService({ db }).reduce(sessionId, factor<1, reason)
//              AntibanAdapter: beforeSend(key,to,content) → {allowed,delayMs,reason?} · afterSend(key,to,content,messageId) · afterSendFailed(key,error)
//              BaileysAntibanAdapter({ config?, create? }) · createDeliver({ antiban, sleep?, health?, limits?, sessionIdOf? }) → DeliverFn
//              AntibanBlockedError (code ANTIBAN_BLOCKED) · antibanModeFromEnv(env) · createAntibanAdapter({ env?, mode?, ... })
//   API: POST /api/sessions/:id/messages {phone, content} → 202 MessageView (queued)
//        GET/PUT /api/sessions/:id/limits → { configured, reductionFactor, effective, warmupDailyLimit, defaults }
import './env'
import { randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import * as core from '@wsm/core'
import { lit, sqlOk } from '../helpers/pg'
import { api, randomPhone, type Ctx } from '../T08/shared'

export * from '../T08/shared'

export const C = core as Record<string, any>

export const GATES = ['auth', 'sessionExists', 'connected', 'contactAllowed', 'warmupLimit', 'rateLimit', 'enqueue'] as const

export const GATE_CODES: Record<string, [string, number]> = {
  auth: ['UNAUTHORIZED', 401],
  sessionExists: ['SESSION_NOT_FOUND', 404],
  connected: ['SESSION_NOT_CONNECTED', 409],
  contactAllowed: ['CONTACT_NOT_ALLOWED', 403],
  warmupLimit: ['WARMUP_LIMIT', 429],
  rateLimit: ['RATE_LIMIT', 429],
}

/** Contato com consentimento (ou com as flags informadas), criado pela API do T07. */
export async function createContact(ctx: Ctx, opts: { phone?: string; consent?: boolean; opt_out?: boolean } = {}) {
  const phone = opts.phone ?? randomPhone()
  const consent = opts.consent ?? true
  const body: Record<string, unknown> = { phone, name: `contato-${randomBytes(2).toString('hex')}`, consent }
  if (consent) Object.assign(body, { consent_at: new Date().toISOString(), consent_source: 'teste-aceitacao' })
  const res = await api(ctx, 'POST', '/api/contacts', body)
  expect(res.status, `POST /api/contacts → ${res.text}`).toBe(201)
  if (opts.opt_out) {
    const upd = await api(ctx, 'PATCH', `/api/contacts/${res.body.id}`, { opt_out: true })
    expect(upd.status, `PATCH opt_out → ${upd.text}`).toBe(200)
  }
  return { id: res.body.id as string, phone }
}

export const send = (ctx: Ctx, sessionId: string, phone: string, text = `oi ${randomBytes(3).toString('hex')}`) =>
  api(ctx, 'POST', `/api/sessions/${sessionId}/messages`, { phone, content: { text } })

export const messageCount = (ctx: Ctx, sessionId: string) =>
  Number(sqlOk(ctx.tempDb.url, `SELECT count(*) FROM messages WHERE session_id = ${lit(sessionId)};`)[0]![0])

/**
 * Insere `n` mensagens outbound direto no banco (contrato T01), criadas `agoMs` atrás.
 * Serve para simular volume já enviado sem passar pelo transporte.
 */
export function seedMessages(ctx: Ctx, sessionId: string, n: number, opts: { agoMs?: number; status?: string } = {}) {
  if (n <= 0) return
  const ago = Math.max(0, Math.round(opts.agoMs ?? 1_000))
  const status = opts.status ?? 'sent'
  sqlOk(
    ctx.tempDb.url,
    `INSERT INTO messages (session_id, direction, phone, content, status, created_at, updated_at)
       SELECT ${lit(sessionId)}, 'outbound', '+5511900000000', '{"text":"seed"}'::jsonb, ${lit(status)}::message_status,
              now() - make_interval(secs => ${ago / 1000}), now()
         FROM generate_series(1, ${n});`,
  )
}

/** Ajusta o início do warm-up da sessão (idade da sessão para o cronograma do T10). */
export function setWarmupStart(ctx: Ctx, sessionId: string, agoMs: number) {
  sqlOk(ctx.tempDb.url, `UPDATE sessions SET warmup_started_at = now() - make_interval(secs => ${agoMs / 1000}) WHERE id = ${lit(sessionId)};`)
}

export const setStatus = (ctx: Ctx, id: string, status: string) => sqlOk(ctx.tempDb.url, `UPDATE sessions SET status = ${lit(status)} WHERE id = ${lit(id)};`)

export const getLimits = async (ctx: Ctx, id: string) => {
  const res = await api(ctx, 'GET', `/api/sessions/${id}/limits`)
  expect(res.status, `GET /limits → ${res.text}`).toBe(200)
  return res.body as { configured: Lim; effective: Lim; reductionFactor: number; warmupDailyLimit: number | null; defaults: Lim }
}

export const putLimits = (ctx: Ctx, id: string, body: Partial<Lim>) => api(ctx, 'PUT', `/api/sessions/${id}/limits`, body)

export interface Lim {
  perMinute: number
  perHour: number
  perDay: number
}

/** Libera os limites de taxa da sessão (para isolar o gate de warm-up). */
export async function relaxRateLimits(ctx: Ctx, id: string) {
  const res = await putLimits(ctx, id, { perMinute: 10_000, perHour: 10_000, perDay: 10_000 })
  expect(res.status, `PUT /limits → ${res.text}`).toBe(200)
}

export const DAY = 24 * 60 * 60 * 1000

/** Adapter espião: registra a sequência de chamadas; decisão configurável. */
export function spyAdapter(decide: (key: string, to: string, content: any) => { allowed: boolean; delayMs: number; reason?: string } = () => ({ allowed: true, delayMs: 0 })) {
  const calls: Array<{ fn: string; args: any[] }> = []
  return {
    calls,
    beforeSend: async (key: string, to: string, content: any) => {
      calls.push({ fn: 'beforeSend', args: [key, to, content] })
      return decide(key, to, content)
    },
    afterSend: (...args: any[]) => void calls.push({ fn: 'afterSend', args }),
    afterSendFailed: (...args: any[]) => void calls.push({ fn: 'afterSendFailed', args }),
  }
}

/** Erro de envio 403 no formato que o transporte reporta. */
export const forbiddenError = () => Object.assign(new Error('forbidden'), { statusCode: 403, output: { statusCode: 403 } })
