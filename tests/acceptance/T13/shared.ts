// Setup comum do T13: reaproveita o setup do T08/T09 (banco descartável + Redis + SessionManager com FakeTransport
// + MessageQueue + createApp) e liga a IA assistiva com um provedor FAKE (nunca a API real).
// Contrato combinado com o Operário (T13):
//   @wsm/core:   normalizeAiText · hashAiText (normalizeText já é do T07) · aiConfigFromEnv(env) · AiProvider { generate({model,maxTokens,text,signal}) → {intent,confidence,text} }
//                new AiAssistant({ provider?, config, logger? }).suggest(text) → { intent, confidence, text, model, source: provider|cache|fallback }
//   @wsm/worker: attachAi(manager, { db, assistant, logger? }) → { stop(), idle() }
//                inbound persistido em messages (direction 'inbound', status 'delivered') antes de classificar; opt-out do T07 tem prioridade
//   @wsm/api:    /api/suggestions (GET lista ?sessionId&status → {items}, GET /:id, POST /:id/approve {text?}, POST /:id/reject)
import '../T09/env'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, expect } from 'vitest'
import * as core from '@wsm/core'
import * as worker from '@wsm/worker'
import { lit, sqlOk } from '../helpers/pg'
import { api, useQueue, type Ctx } from '../T08/shared'

export * from '../T09/shared'

export const C = core as Record<string, any>
export const W = worker as Record<string, any>

export const SMALL = 'modelo-pequeno-teste'
export const LARGE = 'modelo-grande-teste'
export const FALLBACK_INTENTS = ['greeting', 'pricing', 'scheduling', 'support', 'complaint', 'thanks', 'question', 'other']

export interface ProviderCall {
  model: string
  maxTokens: number
  text: string
}

export type Behavior = (req: ProviderCall & { signal?: AbortSignal }) => Promise<{ intent: string; confidence: number; text: string }>

export const confident: Behavior = async (req) => ({ intent: 'pricing', confidence: 0.95, text: `Resposta (${req.model}) para: ${req.text}` })

/** Provedor fake: registra as chamadas; o comportamento é trocável por teste. */
export class FakeProvider {
  calls: ProviderCall[] = []
  behavior: Behavior = confident
  async generate(req: ProviderCall & { signal?: AbortSignal }) {
    this.calls.push({ model: req.model, maxTokens: req.maxTokens, text: req.text })
    return this.behavior(req)
  }
}

export function assistant(provider: FakeProvider | undefined, config: Record<string, unknown> = {}) {
  const AiAssistant = C.AiAssistant
  if (typeof AiAssistant !== 'function') throw new Error('@wsm/core não exporta AiAssistant')
  const opts: Record<string, unknown> = { config: { smallModel: SMALL, largeModel: LARGE, confidenceThreshold: 0.6, maxTokens: 256, timeoutMs: 2_000, ...config } }
  if (provider) opts.provider = provider
  return new AiAssistant(opts)
}

export interface AiCtx extends Ctx {
  provider: FakeProvider
  ai: { stop(): unknown; idle(): Promise<void> }
}

/** Setup do T08 + attachAi com provedor fake. */
export function useAi(): AiCtx {
  const ctx = useQueue() as AiCtx
  beforeAll(async () => {
    ctx.provider = new FakeProvider()
    const attachAi = W.attachAi
    if (typeof attachAi !== 'function') throw new Error('@wsm/worker não exporta attachAi')
    ctx.ai = await attachAi(ctx.manager, { db: ctx.db, assistant: assistant(ctx.provider), logger: ctx.logger })
  })
  afterAll(async () => {
    try {
      await ctx.ai?.stop()
    } catch {
      /* ignora */
    }
  })
  return ctx
}

export const jidOf = (phone: string) => `${phone.replace(/^\+/, '')}@s.whatsapp.net`

/** Simula mensagem recebida no transporte e espera o processamento da IA. */
export async function receive(ctx: AiCtx, t: any, phone: string, text: string, extra: Record<string, unknown> = {}) {
  const msg = t.receive({ from: jidOf(phone), text, ...extra })
  await ctx.ai.idle()
  return msg as { id: string }
}

export async function suggestions(ctx: Ctx, query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString()
  const res = await api(ctx, 'GET', `/api/suggestions?${qs}`)
  expect(res.status, `GET /api/suggestions → ${res.text}`).toBe(200)
  return (Array.isArray(res.body) ? res.body : (res.body?.items ?? [])) as any[]
}

export function inboundRows(ctx: Ctx, sessionId: string) {
  return sqlOk(
    ctx.tempDb.url,
    `SELECT id, phone, content::text, coalesce(transport_message_id, '') FROM messages WHERE session_id = ${lit(sessionId)} AND direction = 'inbound' ORDER BY created_at;`,
  ).map(([id, phone, content, tmid]) => ({ id: id!, phone: phone!, content: JSON.parse(content!), transportMessageId: tmid! }))
}

export const outboundCount = (ctx: Ctx, sessionId: string) =>
  Number(sqlOk(ctx.tempDb.url, `SELECT count(*) FROM messages WHERE session_id = ${lit(sessionId)} AND direction = 'outbound';`)[0]![0])

export const suggestionCount = (ctx: Ctx, sessionId: string) =>
  Number(sqlOk(ctx.tempDb.url, `SELECT count(*) FROM suggestions WHERE session_id = ${lit(sessionId)};`)[0]![0])

export const uniq = (p = 'msg') => `${p} ${randomBytes(4).toString('hex')}`
