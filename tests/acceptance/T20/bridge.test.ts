// AC-T20-05: API e worker em "containers" separados, em processo: a API usa o cliente da ponte do T16
// (createWorkerBridge) e o worker serve a ponte (createInternalApp) com os targets do boot (createBridgeTargets).
// O fetch do cliente é ligado direto ao app interno (sem porta, sem docker).
import './env'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as apiPkg from '@wsm/api'
import { createDb } from '@wsm/db'
import * as worker from '@wsm/worker'
import { call, captureLogger, closeQuietly, createRedis } from '../helpers/app'
import { tail } from '../helpers/exec'
import { expectApiError } from '../helpers/http'
import { createTempDb, dropTempDb, lit, migrate, sqlOk, type TempDb } from '../helpers/pg'
import { createTransportFactory, type TransportFactory } from '../T05/shared'
import { jidOfPhone, newGroupId, randomPhone, REDIS_URL } from './shared'

const A = apiPkg as Record<string, any>
const W = worker as Record<string, any>

describe('T20 — adição pela ponte interna API ↔ worker', () => {
  const INTERNAL = `int_${randomBytes(12).toString('hex')}`
  const ctx = {} as { tempDb: TempDb; db: any; redis: any; logger: any; token: string; manager: any; tf: TransportFactory; internal: any; app: any; badApp: any }

  const stubQueue = { get: async () => null, list: async () => [], events: async () => [], cancel: async () => null, enqueue: async () => null }
  const stubHealth = { getHealth: async () => null }

  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t20b')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    ctx.logger = (await captureLogger()).logger
    ctx.token = `tok_${randomBytes(16).toString('hex')}`
    ctx.tf = createTransportFactory()
    ctx.manager = new W.SessionManager({ db: ctx.db, logger: ctx.logger, transportFactory: ctx.tf.factory, sleep: async () => {}, pairingTimeoutMs: 5_000 })
    await ctx.manager.start()

    // lado worker
    const targets = W.createBridgeTargets({ manager: ctx.manager, queue: stubQueue, health: stubHealth, db: ctx.db })
    ctx.internal = W.createInternalApp({ token: INTERNAL, targets, logger: ctx.logger })

    // lado API: cliente da ponte com fetch ligado ao app interno
    const mkApp = async (token: string) => {
      const bridge = A.createWorkerBridge({ url: 'http://worker.internal', token, fetch: (u: string, init: any) => ctx.internal.request(u, init) })
      return (A.createApp as any)({ db: ctx.db, redis: ctx.redis, logger: ctx.logger, apiToken: ctx.token, sessions: bridge.sessions, messages: bridge.messages, health: bridge.health, groups: bridge.groups })
    }
    ctx.app = await mkApp(INTERNAL)
    ctx.badApp = await mkApp('token-interno-errado')
  })
  afterAll(async () => {
    await ctx.manager?.stop().catch(() => {})
    await closeQuietly(ctx.redis)
    await closeQuietly(ctx.db)
    dropTempDb(ctx.tempDb)
  })

  const api = (app: any, method: string, path: string, body?: unknown) => call(app, method, path, { token: ctx.token, body })

  /** Sessão admin conectada no "worker", com um grupo em que é admin (ou não). */
  async function adminWithGroup(isAdmin = true) {
    const created = await api(ctx.app, 'POST', '/api/sessions', { name: `adm-${randomBytes(2).toString('hex')}`, phone: randomPhone() })
    expect(created.status, created.text).toBe(201)
    const id = created.body.id as string
    expect((await api(ctx.app, 'POST', `/api/sessions/${id}/qr`)).status).toBe(202)
    await expect.poll(() => ctx.tf.connectCount(id), { timeout: 5_000 }).toBe(1)
    const t = ctx.tf.last(id)!
    await t.login()
    await expect.poll(() => sqlOk(ctx.tempDb.url, `SELECT status FROM sessions WHERE id = ${lit(id)};`)[0]?.[0], { timeout: 5_000 }).toBe('WARMING')
    const groupId = newGroupId()
    t.setGroups([{ id: groupId, name: 'G-ponte', participants: 3, announce: false, isAdmin, members: [] }])
    return { id, t, groupId }
  }

  async function target() {
    const r = await api(ctx.app, 'POST', '/api/sessions', { name: `alvo-${randomBytes(2).toString('hex')}`, phone: randomPhone() })
    expect(r.status, r.text).toBe(201)
    return { id: r.body.id as string, jid: jidOfPhone(r.body.phone) }
  }

  const add = (app: any, adminId: string, groupId: string, targetSessionId: string) =>
    api(app, 'POST', `/api/sessions/${adminId}/groups/${encodeURIComponent(groupId)}/participants`, { targetSessionId })

  it('AC-T20-05 a API adiciona pelo worker (ponte interna com token): o transporte do worker recebe a adição', async () => {
    const admin = await adminWithGroup()
    const t = await target()
    const r = await add(ctx.app, admin.id, admin.groupId, t.id)
    expect(r.status, r.text).toBe(200)
    expect(r.body).toMatchObject({ result: 'added', jid: t.jid, groupId: admin.groupId })
    expect(admin.t.groupAdds).toEqual([{ groupId: admin.groupId, jid: t.jid }])
  })

  it('AC-T20-05 os códigos do worker atravessam a ponte: NOT_GROUP_ADMIN 403 e RATE_LIMIT 429', async () => {
    const notAdmin = await adminWithGroup(false)
    const t1 = await target()
    expectApiError(await add(ctx.app, notAdmin.id, notAdmin.groupId, t1.id), 'NOT_GROUP_ADMIN', 403)

    const admin = await adminWithGroup()
    const t2 = await target()
    expect((await add(ctx.app, admin.id, admin.groupId, t1.id)).status).toBe(200)
    expectApiError(await add(ctx.app, admin.id, admin.groupId, t2.id), 'RATE_LIMIT', 429)
    expect(admin.t.groupAdds).toHaveLength(1)
  })

  it('AC-T20-05 com token interno errado nada chega ao transporte do worker', async () => {
    const admin = await adminWithGroup()
    const t = await target()
    const r = await add(ctx.badApp, admin.id, admin.groupId, t.id)
    expect(r.status, r.text).toBeGreaterThanOrEqual(400)
    expect(r.status).not.toBe(200)
    expect(admin.t.groupAdds).toEqual([])
  })

  it('AC-T20-05 a rota de adição da ponte exige o token interno (401 sem token ou com token errado)', async () => {
    const admin = await adminWithGroup()
    const t = await target()
    const bodies = [
      { target: 'sessions', method: 'addGroupParticipant', args: [admin.id, admin.groupId, t.id] },
      { target: 'groups', method: 'addParticipant', args: [{ adminSessionId: admin.id, groupId: admin.groupId, targetSessionId: t.id }] },
    ]
    for (const body of bodies) {
      for (const auth of [undefined, 'Bearer token-errado', `Bearer ${ctx.token}`]) {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (auth) headers.authorization = auth
        const res: Response = await ctx.internal.request('http://worker.internal/internal/rpc', { method: 'POST', headers, body: JSON.stringify(body) })
        expect(res.status, `${body.target}.${body.method} com ${auth ?? 'sem token'}`).toBe(401)
      }
    }
    expect(admin.t.groupAdds).toEqual([])
  })

  it('AC-T20-05 a ponte não expõe variante em lote nem de entrada em grupo', async () => {
    const admin = await adminWithGroup()
    for (const method of ['addGroupParticipants', 'addParticipants', 'bulkAdd', 'joinGroup', ['group', 'Accept', 'Invite'].join('')]) {
      for (const target of ['sessions', 'groups']) {
        const res: Response = await ctx.internal.request('http://worker.internal/internal/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL}` },
          body: JSON.stringify({ target, method, args: [admin.id, admin.groupId, []] }),
        })
        expect(res.status, `${target}.${method} deveria não existir`).toBeGreaterThanOrEqual(400)
        expect(res.status).not.toBe(200)
      }
    }
    expect(admin.t.groupAdds).toEqual([])
  })
})
