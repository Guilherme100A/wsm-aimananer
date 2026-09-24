import { describe, expect, it } from 'vitest'
import { createDb } from '@wsm/db'
import { call, captureLogger, closeQuietly, createDeadRedis, withTimeout } from '../helpers/app'
import { buildApp, newToken, useApp } from './shared'

describe('T03 — GET /health', () => {
  const ctx = useApp()

  it('AC-T03-01 GET /health responde 200 { status: "ok", db: "ok", redis: "ok" } sem Authorization', async () => {
    const res = await call(ctx.app, 'GET', '/health', { token: null })
    expect(res.status, res.text).toBe(200)
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok' })
  })

  it('AC-T03-01 GET /health não exige auth nem com token inválido', async () => {
    const res = await call(ctx.app, 'GET', '/health', { token: 'token-errado' })
    expect(res.status, res.text).toBe(200)
    expect(res.body?.status).toBe('ok')
  })

  it('AC-T03-01 GET /health reporta redis "down" (200, sem pendurar) quando o Redis está inacessível', async () => {
    const redis = await createDeadRedis()
    const { logger } = await captureLogger()
    try {
      const app = await buildApp({ db: ctx.db, redis, logger, apiToken: newToken() })
      const res = await withTimeout(call(app, 'GET', '/health', { token: null }), 10_000, 'GET /health com Redis fora')
      expect(res.status, res.text).toBe(200)
      expect(res.body).toMatchObject({ status: 'ok', db: 'ok', redis: 'down' })
    } finally {
      await closeQuietly(redis)
    }
  })

  it('AC-T03-01 GET /health reporta db "down" (200, sem pendurar) quando o Postgres está inacessível', async () => {
    const db = await (createDb as any)('postgres://wsm:wsm@127.0.0.1:1/wsm')
    const { logger } = await captureLogger()
    try {
      const app = await buildApp({ db, redis: ctx.redis, logger, apiToken: newToken() })
      const res = await withTimeout(call(app, 'GET', '/health', { token: null }), 15_000, 'GET /health com Postgres fora')
      expect(res.status, res.text).toBe(200)
      expect(res.body).toMatchObject({ status: 'ok', db: 'down', redis: 'ok' })
    } finally {
      await closeQuietly(db)
    }
  })
})
