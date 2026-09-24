// /api/sessions/:id/limits (T09, AC-T09-05): limites de envio por sessão.
// PUT é o único caminho que aumenta limites (manual, auditado); o efetivo nunca passa do cronograma de warm-up.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { InvalidLimitsError, SessionError, SessionLimitsService } from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

declare module '../types' {
  interface AppDeps {
    /** Serviço de limites por sessão (T09). Opcional: default criado a partir de `db`. */
    limits?: SessionLimitsService
  }
}

const limit = z.number().int().min(1).max(1_000_000)
export const updateLimitsSchema = z
  .object({ perMinute: limit.optional(), perHour: limit.optional(), perDay: limit.optional() })
  .strict()
  .refine((b) => b.perMinute !== undefined || b.perHour !== undefined || b.perDay !== undefined, {
    message: 'nothing to update (perMinute, perHour or perDay)',
  })

const uuid = z.uuid()

function sessionId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? ''
  if (!uuid.safeParse(id).success) throw new ApiError('SESSION_NOT_FOUND', `session ${id} not found`)
  return id
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof SessionError && err.code === 'SESSION_NOT_FOUND') throw new ApiError('SESSION_NOT_FOUND', err.message)
    if (err instanceof InvalidLimitsError) throw new ApiError('VALIDATION_ERROR', err.message)
    throw err
  }
}

export function limitsRoutes(deps: Pick<AppDeps, 'db' | 'limits'>) {
  const limits = deps.limits ?? new SessionLimitsService(deps.db)

  return new Hono<AppEnv>()
    .get('/api/sessions/:id/limits', async (c) => c.json(await run(() => limits.get(sessionId(c)))))
    .put('/api/sessions/:id/limits', validate('json', updateLimitsSchema), async (c) => {
      const id = sessionId(c)
      const body = c.req.valid('json')
      const view = await run(() => limits.set(id, body))
      setAudit(c, { action: 'session.limits_update', targetType: 'session', targetId: id, detail: { limits: body, effective: view.effective } })
      return c.json(view)
    })
}
