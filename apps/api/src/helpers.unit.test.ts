import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { loadConfig } from './config'
import { ApiError, ERROR_STATUS, errorBody, toApiError } from './errors'
import { deriveAudit } from './middleware/audit'
import { parseBearer, tokenMatches } from './middleware/auth'
import { probe } from './routes/health'

describe('parseBearer / tokenMatches', () => {
  it('extrai token Bearer (case-insensitive)', () => {
    expect(parseBearer('Bearer abc')).toBe('abc')
    expect(parseBearer('bearer abc')).toBe('abc')
    expect(parseBearer('Bearer')).toBeUndefined()
    expect(parseBearer('Basic abc')).toBeUndefined()
    expect(parseBearer(undefined)).toBeUndefined()
  })

  it('compara tokens', () => {
    expect(tokenMatches('a', 'a')).toBe(true)
    expect(tokenMatches('a', 'b')).toBe(false)
    expect(tokenMatches('a', 'aa')).toBe(false)
  })
})

describe('errors', () => {
  it('status da tabela 3.4', () => {
    expect(ERROR_STATUS).toMatchObject({
      UNAUTHORIZED: 401,
      VALIDATION_ERROR: 400,
      SESSION_NOT_FOUND: 404,
      SESSION_NOT_CONNECTED: 409,
      INVALID_TRANSITION: 409,
      PROXY_IN_USE: 409,
      CONTACT_NOT_ALLOWED: 403,
      WARMUP_LIMIT: 429,
      RATE_LIMIT: 429,
    })
    expect(new ApiError('RATE_LIMIT', 'x').status).toBe(429)
  })

  it('omite details quando ausente', () => {
    expect(errorBody(new ApiError('SESSION_NOT_FOUND', 'nope'))).toEqual({ error: { code: 'SESSION_NOT_FOUND', message: 'nope' } })
  })

  it('converte ZodError com paths aninhados', () => {
    const r = z.object({ a: z.object({ b: z.number() }) }).safeParse({ a: { b: 'x' } })
    const err = toApiError(r.error)
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.details).toEqual({ issues: [expect.objectContaining({ path: 'a.b' })] })
  })
})

describe('deriveAudit', () => {
  it('deriva alvo da URL', () => {
    expect(deriveAudit('POST', '/api/sessions/s1/pause')).toEqual({ action: 'POST /api/sessions/s1/pause', targetType: 'sessions', targetId: 's1' })
    expect(deriveAudit('POST', '/api/proxies', '42')).toMatchObject({ targetType: 'proxies', targetId: '42' })
    expect(deriveAudit('POST', '/api/proxies')).toMatchObject({ targetId: '-' })
  })
})

describe('probe', () => {
  it('ok, erro e timeout', async () => {
    expect(await probe(async () => 1, 50)).toBe('ok')
    expect(await probe(async () => Promise.reject(new Error('x')), 50)).toBe('down')
    expect(await probe(() => new Promise(() => {}), 20)).toBe('down')
  })
})

describe('loadConfig', () => {
  it('aplica defaults e exige variáveis', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', API_TOKEN: 't' })
    expect(cfg).toMatchObject({ PORT: 3000, LOG_LEVEL: 'info' })
    expect(() => loadConfig({})).toThrow(/API_TOKEN/)
  })
})
