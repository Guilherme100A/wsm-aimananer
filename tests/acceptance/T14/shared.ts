// Setup do T14: reaproveita o setup do T05 (api + SessionManager + FakeTransport no mesmo processo).
// Contrato combinado com o Operário:
//   GET  /api/sessions/:id/groups      → 200 { items: [{ id, name, participants, status, announce, communityId }] } (ordenado por name)
//   POST /api/sessions/:id/groups/refresh → 200 { items } — ação manual, auditada (action 'group.refresh', target_type 'session', detail.count)
//   status: 'announce' (announce = true, só admins enviam) | 'open'
//   fora de WARMING/STABLE ou sem transporte vivo → 409 SESSION_NOT_CONNECTED
import { vi } from 'vitest'
import { lit, sqlOk } from '../helpers/pg'
import { connectedSession, type Ctx } from '../T05/shared'

export * from '../T05/shared'

export const GROUPS = [
  { id: '120363000000000002@g.us', name: 'Suporte Loja', participants: 42, announce: false },
  { id: '120363000000000001@g.us', name: 'Avisos Clientes', participants: 250, announce: true, communityId: '120363000000000099@g.us' },
  { id: '120363000000000003@g.us', name: 'Equipe', participants: 5, announce: false },
]

/** Sessão conectada (WARMING) com grupos no FakeTransport e spy em fetchGroups. */
export async function sessionWithGroups(ctx: Ctx, groups = GROUPS) {
  const s = await connectedSession(ctx)
  const t = s.transport
  t.setGroups(groups.map((g) => ({ ...g })))
  const fetchSpy = vi.spyOn(t, 'fetchGroups')
  return { ...s, fetchSpy }
}

export interface AuditRow {
  actor: string
  action: string
  target_type: string | null
  target_id: string | null
  detail: any
}

export function auditRows(ctx: Ctx): AuditRow[] {
  return sqlOk(ctx.tempDb.url, `SELECT row_to_json(t) FROM (SELECT actor, action, target_type, target_id, detail FROM audit_logs ORDER BY id) t;`).map((r) => JSON.parse(r[0]!))
}

export const auditCount = (ctx: Ctx) => Number(sqlOk(ctx.tempDb.url, 'SELECT count(*) FROM audit_logs;')[0]![0])

export const setStatus = (ctx: Ctx, id: string, status: string) => sqlOk(ctx.tempDb.url, `UPDATE sessions SET status = ${lit(status)} WHERE id = ${lit(id)};`)
