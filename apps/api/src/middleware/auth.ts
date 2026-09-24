// Auth Bearer para `/api/*` (AC-T03-02). Comparação em tempo constante.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { ApiError } from '../errors'
import type { AppEnv } from '../types'

const digest = (s: string) => createHash('sha256').update(s).digest()

export function tokenMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected))
}

/** Extrai o token de `Authorization: Bearer <token>`; `undefined` se ausente/malformado. */
export function parseBearer(header: string | undefined): string | undefined {
  const m = header?.match(/^Bearer\s+(\S+)\s*$/i)
  return m?.[1]
}

export function bearerAuth(apiToken: string): MiddlewareHandler<AppEnv> {
  if (!apiToken) throw new Error('apiToken is required')
  return async (c, next) => {
    const token = parseBearer(c.req.header('authorization'))
    if (!token || !tokenMatches(token, apiToken)) {
      throw new ApiError('UNAUTHORIZED', 'missing or invalid bearer token')
    }
    c.set('actor', 'api_token')
    await next()
  }
}
