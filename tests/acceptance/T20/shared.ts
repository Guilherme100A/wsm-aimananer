// Setup do T20 (adicionar UM número a um grupo, ação manual do admin). API + SessionManager + FakeTransport
// no mesmo processo (como T05/T14).
// Contrato FINAL combinado com o Operário (Brasa) — a versão que ele aceitou ('cruzamos de novo...'):
//   WaTransport.addGroupParticipant(groupId, jid) → [{ jid, status, code? }]
//     status: added | already_member | not_admin | group_not_found | not_allowed (privacidade) | failed — não lança
//     (só TransportNotConnectedError). GroupSummary e GET /groups ganham isAdmin.
//   FakeTransport: setGroups([{ id, name, participants, announce, isAdmin, members? }]) · groupAdds[] · failNextGroupAdd(err)
//   POST /api/sessions/:id/groups/:groupId/participants { targetSessionId } (strict; array → 400)
//     404 SESSION_NOT_FOUND · 400 alvo = :id · 404 alvo inexistente · 400 alvo sem telefone · 409 SESSION_NOT_CONNECTED
//     · 404 GROUP_NOT_FOUND · 403 NOT_GROUP_ADMIN · 429 RATE_LIMIT
//     → 200 { groupId, targetSessionId, jid, result: added|already_member|not_allowed|failed, code? }
//   Freio: 1 tentativa que chega ao transporte por minuto por sessão admin; janela em audit_logs comparada com o
//     relógio createApp deps.groupAddNow (avançar 61 s ou recuar created_at libera).
//   Auditoria em toda tentativa (exceto 400 de schema): action 'group.participant.add', target_type 'session',
//     target_id = :id, detail { groupId, targetSessionId, jid|null, result, attempted }, ator do auth.
//   Ponte: SessionsControl.addGroupParticipant(admin, groupId, target) · RPC sessions.addGroupParticipant ·
//     @wsm/worker createBridgeTargets({ manager, queue, health, db, groupAddNow }) para createInternalApp.
import './env'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect } from 'vitest'
import { createApp } from '@wsm/api'
import { createDb } from '@wsm/db'
import * as worker from '@wsm/worker'
import { call, captureLogger, closeQuietly, createRedis } from '../helpers/app'
import { tail } from '../helpers/exec'
import { createTempDb, dropTempDb, lit, migrate, sqlOk, type TempDb } from '../helpers/pg'
import { createTransportFactory, type TransportFactory } from '../T05/shared'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

export interface GCtx {
  tempDb: TempDb
  db: any
  redis: any
  logger: any
  token: string
  app: any
  manager: any
  tf: TransportFactory
  /** relógio do freio (ms), injetado como deps.groupAddNow */
  clock: { now: number }
  advance(ms: number): void
}

export function useGroupsApp(): GCtx {
  const ctx = { clock: { now: Date.now() } } as GCtx
  ctx.advance = (ms) => {
    ctx.clock.now += ms
  }
  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t20')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    ctx.logger = (await captureLogger()).logger
    ctx.token = `tok_${randomBytes(16).toString('hex')}`
    ctx.tf = createTransportFactory()
    ctx.manager = new (worker as any).SessionManager({ db: ctx.db, logger: ctx.logger, transportFactory: ctx.tf.factory, sleep: async () => {}, pairingTimeoutMs: 5_000 })
    ctx.app = await (createApp as any)({
      db: ctx.db,
      redis: ctx.redis,
      logger: ctx.logger,
      apiToken: ctx.token,
      sessions: ctx.manager,
      groupAddNow: () => ctx.clock.now,
    })
    await ctx.manager.start()
  })
  // relógio alinhado ao real a cada teste (a janela compara com audit_logs.created_at); só o teste avança
  beforeEach(() => {
    ctx.clock.now = Date.now()
  })
  afterAll(async () => {
    await ctx.manager?.stop().catch(() => {})
    await closeQuietly(ctx.redis)
    await closeQuietly(ctx.db)
    dropTempDb(ctx.tempDb)
  })
  return ctx
}

export const api = (ctx: { app: any; token: string }, method: string, path: string, body?: unknown, token: string | null = ctx.token) =>
  call(ctx.app, method, path, { token, body })

export const randomPhone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
export const newGroupId = () => `1203630${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}@g.us`
export const jidOfPhone = (phone: string) => `${phone.replace(/^\+/, '')}@s.whatsapp.net`

export async function createSession(ctx: GCtx, name = `s-${randomBytes(2).toString('hex')}`) {
  const r = await api(ctx, 'POST', '/api/sessions', { name, phone: randomPhone() })
  expect(r.status, `POST /api/sessions → ${r.text}`).toBe(201)
  return r.body as { id: string; name: string; phone: string }
}

export const statusOf = (ctx: GCtx, id: string) => sqlOk(ctx.tempDb.url, `SELECT status FROM sessions WHERE id = ${lit(id)};`)[0]?.[0]

export async function connectedSession(ctx: GCtx) {
  const s = await createSession(ctx)
  const qr = await api(ctx, 'POST', `/api/sessions/${s.id}/qr`)
  expect(qr.status, qr.text).toBe(202)
  await expect.poll(() => ctx.tf.connectCount(s.id), { timeout: 5_000 }).toBe(1)
  const t = ctx.tf.last(s.id)!
  await t.login()
  await expect.poll(() => statusOf(ctx, s.id), { timeout: 5_000 }).toBe('WARMING')
  return { ...s, transport: t }
}

/** Sessão admin conectada (WARMING) com um grupo no FakeTransport. */
export async function adminWithGroup(ctx: GCtx, opts: { isAdmin?: boolean; members?: string[]; name?: string } = {}) {
  const s = await connectedSession(ctx)
  const groupId = newGroupId()
  const groupName = opts.name ?? `Grupo ${randomBytes(2).toString('hex')}`
  s.transport.setGroups([{ id: groupId, name: groupName, participants: 3 + (opts.members?.length ?? 0), announce: false, isAdmin: opts.isAdmin ?? true, members: opts.members ?? [] }])
  return { ...s, groupId, groupName }
}

/** Sessão do sistema que será o número adicionado (não precisa estar conectada). */
export async function targetSession(ctx: GCtx) {
  const s = await createSession(ctx, `alvo-${randomBytes(2).toString('hex')}`)
  return { ...s, jid: jidOfPhone(s.phone) }
}

export const addParticipant = (ctx: GCtx, adminId: string, groupId: string, body: unknown, token: string | null = ctx.token) =>
  api(ctx, 'POST', `/api/sessions/${adminId}/groups/${encodeURIComponent(groupId)}/participants`, body, token)

export interface AuditRow {
  actor: string
  action: string
  target_type: string | null
  target_id: string | null
  detail: any
}

export function addAudits(ctx: { tempDb: TempDb }, adminId?: string): AuditRow[] {
  const where = adminId ? ` AND target_id = ${lit(adminId)}` : ''
  return sqlOk(
    ctx.tempDb.url,
    `SELECT row_to_json(t)::text FROM (SELECT actor, action, target_type, target_id, detail FROM audit_logs WHERE action = 'group.participant.add'${where} ORDER BY id) t;`,
  ).map((r) => JSON.parse(r[0]!))
}

/** Recua a janela do freio (audit_logs) em 61 s para a sessão admin: outra forma de simular 1 minuto. */
export function ageRateWindow(ctx: { tempDb: TempDb }, adminId: string) {
  sqlOk(
    ctx.tempDb.url,
    `UPDATE audit_logs SET created_at = created_at - interval '61 seconds' WHERE action = 'group.participant.add' AND target_id = ${lit(adminId)};`,
  )
}
