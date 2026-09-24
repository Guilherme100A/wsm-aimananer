// /api/suggestions (T13, AC-T13-02): sugestões da IA com aprovação humana. approve envia pelo SendPipeline (T09);
// reject descarta. Ações auditadas.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { SUGGESTION_STATUSES } from '@wsm/db'
import { SendPipeline, SendRejectedError, SuggestionError, SuggestionService, type SendQueue, type WaTransport } from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

export const listSuggestionsQuery = z.object({
  sessionId: z.uuid().optional(),
  status: z.enum(SUGGESTION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export const approveSuggestionSchema = z.object({ text: z.string().trim().min(1).max(4096).optional() })

const uuid = z.uuid()

function suggestionId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? ''
  if (!uuid.safeParse(id).success) throw new ApiError('NOT_FOUND', `suggestion ${id} not found`)
  return id
}

function toApiError(err: unknown): unknown {
  if (err instanceof SendRejectedError) return new ApiError(err.code, err.message, { gate: err.gate, ...err.details })
  if (err instanceof SuggestionError) return new ApiError(err.code, err.message, err.details)
  return err
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

const hasSendQueue = (m: unknown): m is SendQueue => typeof (m as { enqueue?: unknown } | undefined)?.enqueue === 'function'

/** Mesmo pipeline do POST /api/sessions/:id/messages: deps.pipeline ou fila (deps.messages) + transporte (deps.sessions). */
function buildPipeline(deps: Pick<AppDeps, 'db' | 'messages' | 'sessions' | 'pipeline'>): Pick<SendPipeline, 'send'> {
  if (deps.pipeline) return deps.pipeline
  const sessions = deps.sessions as { getTransport?: (id: string) => WaTransport | undefined } | undefined
  return new SendPipeline({
    db: deps.db,
    ...(hasSendQueue(deps.messages) ? { queue: deps.messages } : {}),
    ...(sessions?.getTransport ? { getTransport: (sid: string) => sessions.getTransport!(sid) } : {}),
  })
}

export function suggestionsRoutes(deps: Pick<AppDeps, 'db' | 'messages' | 'sessions' | 'pipeline'>) {
  const service = new SuggestionService(deps.db)
  const pipeline = buildPipeline(deps)

  return new Hono<AppEnv>()
    .get('/api/suggestions', validate('query', listSuggestionsQuery), async (c) => {
      const q = c.req.valid('query')
      return c.json({ items: await run(() => service.list(q)) })
    })
    .get('/api/suggestions/:id', async (c) => c.json(await run(() => service.get(suggestionId(c)))))
    .post('/api/suggestions/:id/approve', async (c) => {
      const id = suggestionId(c)
      const raw = await c.req.text()
      let json: unknown = {}
      if (raw.trim()) {
        try {
          json = JSON.parse(raw)
        } catch {
          throw new ApiError('VALIDATION_ERROR', 'body must be JSON')
        }
      }
      const body = approveSuggestionSchema.parse(json)
      // Rejeição de gate: a sugestão fica failed (error = código) e a resposta é o erro do gate (SPEC 3.4).
      const s = await run(() => service.approve(id, { actor: c.get('actor'), pipeline, ...(body.text !== undefined ? { text: body.text } : {}) }))
      setAudit(c, {
        action: 'suggestion.approve',
        targetType: 'suggestion',
        targetId: id,
        detail: { sessionId: s.sessionId, messageId: s.messageId, edited: body.text !== undefined },
      })
      return c.json(s)
    })
    .post('/api/suggestions/:id/reject', async (c) => {
      const id = suggestionId(c)
      const s = await run(() => service.reject(id, c.get('actor')))
      setAudit(c, { action: 'suggestion.reject', targetType: 'suggestion', targetId: id, detail: { sessionId: s.sessionId } })
      return c.json(s)
    })
}
