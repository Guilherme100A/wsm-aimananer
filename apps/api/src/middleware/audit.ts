// Auditoria de requisições mutantes bem-sucedidas (AC-T03-04).
import type { Context, MiddlewareHandler } from 'hono'
import { auditLogs, type Database } from '@wsm/db'
import type { AppEnv, AuditInfo } from '../types'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface AuditEntry {
  actor: string
  action: string
  targetType: string
  targetId: string
  detail: Record<string, unknown>
}

/** Rotas podem refinar o que é auditado (ação e alvo). Campos omitidos são derivados da URL. */
export function setAudit(c: Context<AppEnv>, info: AuditInfo) {
  c.set('audit', { ...c.get('audit'), ...info })
}

/**
 * Deriva alvo e ação da URL: `/api/proxies/abc/test` → target_type `proxies`, target_id `abc`,
 * action `POST /api/proxies/abc/test`. Sem id na URL, usa o `id` do corpo JSON de resposta; senão `-`.
 */
export function deriveAudit(method: string, path: string, responseId?: string): Omit<AuditEntry, 'actor' | 'detail'> {
  const segs = path.split('/').filter(Boolean)
  const rest = segs[0] === 'api' ? segs.slice(1) : segs
  return {
    action: `${method} ${path}`,
    targetType: rest[0] ?? 'api',
    targetId: rest[1] ?? responseId ?? '-',
  }
}

async function responseId(res: Response): Promise<string | undefined> {
  if (!res.headers.get('content-type')?.includes('application/json')) return undefined
  try {
    const body = (await res.clone().json()) as unknown
    const id = body && typeof body === 'object' ? (body as Record<string, unknown>).id : undefined
    return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
  } catch {
    return undefined
  }
}

export async function writeAudit(db: Database, entry: AuditEntry) {
  await db.insert(auditLogs).values(entry)
}

export function auditMiddleware(db: Database): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next()
    const method = c.req.method
    if (!MUTATING.has(method) || c.res.status < 200 || c.res.status >= 300) return

    const info = c.get('audit') ?? {}
    const derived = deriveAudit(method, c.req.path, info.targetId ? undefined : await responseId(c.res))
    const entry: AuditEntry = {
      actor: c.get('actor') ?? 'anonymous',
      action: info.action ?? derived.action,
      targetType: info.targetType ?? derived.targetType,
      targetId: info.targetId ?? derived.targetId,
      detail: { request_id: c.get('requestId'), status: c.res.status, ...info.detail },
    }
    try {
      // Aguardado antes de responder: o registro existe quando o cliente recebe a resposta.
      await writeAudit(db, entry)
    } catch (err) {
      c.get('logger')?.error({ err, audit: entry }, 'failed to write audit log')
    }
  }
}
