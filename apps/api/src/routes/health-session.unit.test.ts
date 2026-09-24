import { describe, expect, it, vi } from 'vitest'
import { SessionError, type SessionHealth } from '@wsm/core'
import { createApp } from '../app'
import { captureLogger, fakeDb, fakeRedis } from '../test-utils'
import type { HealthControl } from './health-session'

const TOKEN = 't0k'
const ID = '11111111-1111-4111-8111-111111111111'

const HEALTH: SessionHealth = {
  state: 'WARMING',
  warmupPercent: 42,
  score: 88,
  label: 'Good',
  sent: 10,
  received: 3,
  failed: 1,
  disconnects: 2,
  forbidden403: 0,
  lastEventAt: new Date(0).toISOString(),
}

function setup() {
  const health: HealthControl = {
    getHealth: vi.fn(async (id: string) => {
      if (id !== ID) throw new SessionError('SESSION_NOT_FOUND', 'nope')
      return HEALTH
    }),
  }
  const app = createApp({ db: fakeDb().db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN, health })
  const get = (path: string, token: string | null = TOKEN) =>
    app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  return { get, health }
}

describe('GET /api/sessions/:id/health', () => {
  it('200 com o formato do AC-T10-04', async () => {
    const { get } = setup()
    const res = await get(`/api/sessions/${ID}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(HEALTH)
  })

  it('sessão inexistente ou id inválido → 404 SESSION_NOT_FOUND', async () => {
    const { get, health } = setup()
    for (const id of ['22222222-2222-4222-8222-222222222222', 'nope']) {
      const res = await get(`/api/sessions/${id}/health`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SESSION_NOT_FOUND')
    }
    expect(health.getHealth).toHaveBeenCalledTimes(1)
  })

  it('sem token → 401', async () => {
    const { get } = setup()
    expect((await get(`/api/sessions/${ID}/health`, null)).status).toBe(401)
  })
})
