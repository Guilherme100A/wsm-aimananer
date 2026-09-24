// Reconciliação no boot (AC-T16-05): mensagens presas em `processing` por um worker que caiu.
// Política (sem duplicar envio; ver docs/operations.md):
//  - com transport_message_id                 → sent (o WhatsApp aceitou; só faltou gravar)
//  - sem transport_message_id e sem marca     → retrying + job de volta à fila (nunca chegou ao transporte)
//  - sem transport_message_id e COM marca     → failed "delivery state unknown" (pode ter chegado; não reenvia)
import { and, eq } from 'drizzle-orm'
import { MessageStore, type MessageStatusEvent } from '@wsm/core'
import { messages, sessions, type Database } from '@wsm/db'
import type { InflightStore } from './send-guard'

export const UNKNOWN_DELIVERY_ERROR = 'delivery state unknown (worker stopped during send)'

export interface ReconcileResult {
  sent: string[]
  retrying: string[]
  failed: string[]
}

export interface ReconcileOptions {
  db: Database
  inflight: InflightStore
  /** Recoloca o job da mensagem na fila da sessão (idempotente por jobId). */
  requeue: (sessionId: string, messageId: string) => Promise<void>
  /** Notificado a cada transição (métricas/eventos). */
  onStatus?: (ev: MessageStatusEvent) => void
  logger?: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void }
}

export async function reconcileProcessing(opts: ReconcileOptions): Promise<ReconcileResult> {
  const store = new MessageStore(opts.db)
  const stuck = await opts.db
    .select({ id: messages.id, sessionId: messages.sessionId, transportMessageId: messages.transportMessageId })
    .from(messages)
    .where(and(eq(messages.status, 'processing'), eq(messages.direction, 'outbound')))
  const result: ReconcileResult = { sent: [], retrying: [], failed: [] }
  const detail = { reconciled: true, reason: 'worker restart' }

  for (const m of stuck) {
    if (m.transportMessageId) {
      const res = await store.tryTransition(m.id, 'sent', { from: ['processing'], set: { sentAt: new Date(), error: null }, detail })
      if (res) {
        result.sent.push(m.id)
        opts.onStatus?.({ messageId: m.id, sessionId: m.sessionId, from: res.from, to: 'sent' })
      }
      continue
    }
    if (await opts.inflight.has(m.sessionId)) {
      const res = await store.tryTransition(m.id, 'failed', {
        from: ['processing'],
        set: { error: UNKNOWN_DELIVERY_ERROR },
        detail: { ...detail, error: UNKNOWN_DELIVERY_ERROR },
      })
      if (res) {
        result.failed.push(m.id)
        opts.onStatus?.({ messageId: m.id, sessionId: m.sessionId, from: res.from, to: 'failed' })
        opts.logger?.warn({ session_id: m.sessionId, message_id: m.id }, 'message in flight during crash marked failed (not resent)')
      }
      await opts.inflight.clear(m.sessionId)
      continue
    }
    const res = await store.tryTransition(m.id, 'retrying', { from: ['processing'], set: { error: 'interrupted by worker restart' }, detail })
    if (res) {
      result.retrying.push(m.id)
      opts.onStatus?.({ messageId: m.id, sessionId: m.sessionId, from: res.from, to: 'retrying' })
      await opts.requeue(m.sessionId, m.id)
    }
  }
  // Marcas órfãs (envio concluído, mas o worker caiu antes de apagar) tornariam o próximo boot conservador demais.
  const all = await opts.db.select({ sessionId: sessions.id }).from(sessions)
  for (const { sessionId } of all) await opts.inflight.clear(sessionId)
  if (stuck.length) opts.logger?.info({ ...countOf(result) }, 'reconciled messages stuck in processing')
  return result
}

const countOf = (r: ReconcileResult) => ({ sent: r.sent.length, retrying: r.retrying.length, failed: r.failed.length })
