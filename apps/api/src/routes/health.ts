// GET /health (AC-T03-01): público, sempre 200, com o estado de db e redis.
import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { AppDeps, AppEnv } from '../types'

export type CheckStatus = 'ok' | 'down'

/** Roda `check` com timeout; qualquer erro ou demora vira `down`. */
export async function probe(check: () => Promise<unknown>, timeoutMs: number): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
  })
  try {
    await Promise.race([check(), timeout])
    return 'ok'
  } catch {
    return 'down'
  } finally {
    clearTimeout(timer)
  }
}

export function healthRoutes(deps: Pick<AppDeps, 'db' | 'redis' | 'healthTimeoutMs'>) {
  const timeoutMs = deps.healthTimeoutMs ?? 1000
  return new Hono<AppEnv>().get('/health', async (c) => {
    const [db, redis] = await Promise.all([
      probe(() => deps.db.execute(sql`select 1`), timeoutMs),
      probe(() => deps.redis.ping(), timeoutMs),
    ])
    return c.json({ status: 'ok' as const, db, redis }, 200)
  })
}
