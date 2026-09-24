// GET /metrics (AC-T15-01): exposição Prometheus, pública como /health (fora do auth de /api/*).
import { Hono } from 'hono'
import { createMetrics, type WsmMetrics } from '@wsm/core'
import type { AppDeps, AppEnv } from '../types'

declare module '../types' {
  interface AppDeps {
    /** Métricas do processo (T15). Sem elas, /metrics expõe um registry vazio próprio do app. */
    metrics?: WsmMetrics
  }
}

export function metricsRoutes(deps: Pick<AppDeps, 'metrics'>) {
  const metrics = deps.metrics ?? createMetrics()
  return new Hono<AppEnv>().get('/metrics', async (c) => {
    const body = await metrics.render()
    return c.body(body, 200, { 'content-type': metrics.contentType })
  })
}
