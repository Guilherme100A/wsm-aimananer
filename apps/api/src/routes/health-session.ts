// GET /api/sessions/:id/health (T10, AC-T10-04): estado, warm-up e Health Score da sessão.
// O Health Score é apenas um indicador operacional (SPEC 1.4 #6).
import { Hono } from 'hono'
import { z } from 'zod'
import { HealthService, type SessionHealth, type WarmupSchedule } from '@wsm/core'
import { ApiError } from '../errors'
import type { AppDeps, AppEnv } from '../types'
import { toApiError } from './sessions'

/** Contrato que o HealthMonitor (apps/worker) implementa. */
export interface HealthControl {
  getHealth(sessionId: string): Promise<SessionHealth>
}

declare module '../types' {
  interface AppDeps {
    /** HealthMonitor do worker (T10). Sem ele, a rota calcula direto no banco (HealthService). */
    health?: HealthControl
    /** Opções do HealthService usado quando `health` não é fornecido. */
    healthOptions?: { now?: () => Date; schedule?: Partial<WarmupSchedule>; windowMs?: number }
  }
}

const uuid = z.uuid()

export function healthSessionRoutes(deps: Pick<AppDeps, 'db' | 'health' | 'healthOptions'>) {
  const health: HealthControl = deps.health ?? new HealthService(deps.db, deps.healthOptions ?? {})
  return new Hono<AppEnv>().get('/api/sessions/:id/health', async (c) => {
    const id = c.req.param('id')
    if (!uuid.safeParse(id).success) throw new ApiError('SESSION_NOT_FOUND', `session ${id} not found`)
    try {
      return c.json(await health.getHealth(id))
    } catch (err) {
      throw toApiError(err)
    }
  })
}
