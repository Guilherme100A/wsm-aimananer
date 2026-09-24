// Jobs órfãos no boot (AC-T16-05): um worker morto (SIGKILL/OOM) deixa o job da mensagem em `active` no BullMQ,
// com o lock válido por até lockDuration (30 s). Com concorrência global 1 por sessão, esse job ocupa a vaga
// e segura a fila até o BullMQ detectá-lo como travado (30–60 s).
// No boot, ANTES de qualquer Worker da fila começar, todo job `active` é órfão: o deploy tem um único processo
// worker (docs/operations.md). O job é devolvido à espera: apagamos o lock, removemos o job e o recriamos com
// o mesmo jobId se a mensagem ainda estiver queued/retrying. O processador da fila ignora mensagens fora de
// queued/retrying, então nada é reenviado depois de `sent` e nada é perdido.
import type { MessageStatus } from '@wsm/core'

/** Subconjunto do Queue do BullMQ usado aqui. */
export interface OrphanQueue {
  getJobs(types: 'active'[]): Promise<Array<{ id?: string; data: { messageId?: string }; remove(): Promise<void> }>>
  toKey(type: string): string
  add(name: string, data: { messageId: string }, opts: Record<string, unknown>): Promise<unknown>
}

export interface RecoverOrphanJobsOptions {
  sessionIds: string[]
  queueFor(sessionId: string): OrphanQueue
  redis: { del(key: string): Promise<unknown> }
  messageStatus(messageId: string): Promise<MessageStatus | undefined>
  /** Opções do job (as mesmas do enqueue do T08). */
  jobOptions: Record<string, unknown>
  logger?: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void }
}

export interface RecoverOrphanJobsResult {
  /** Jobs devolvidos à espera (mensagem ainda pendente). */
  requeued: string[]
  /** Jobs descartados (mensagem já enviada, falha, cancelada ou inexistente). */
  dropped: string[]
}

const PENDING: readonly MessageStatus[] = ['queued', 'retrying']

export async function recoverOrphanJobs(opts: RecoverOrphanJobsOptions): Promise<RecoverOrphanJobsResult> {
  const result: RecoverOrphanJobsResult = { requeued: [], dropped: [] }
  for (const sessionId of opts.sessionIds) {
    const q = opts.queueFor(sessionId)
    const active = await q.getJobs(['active'])
    for (const job of active) {
      if (!job.id) continue
      const messageId = job.data.messageId ?? job.id
      await opts.redis.del(q.toKey(`${job.id}:lock`))
      try {
        await job.remove()
      } catch (err) {
        opts.logger?.warn({ session_id: sessionId, job_id: job.id, err: err instanceof Error ? err.message : String(err) }, 'orphan job removal failed')
        continue
      }
      const status = await opts.messageStatus(messageId)
      if (status && PENDING.includes(status)) {
        await q.add('send', { messageId }, { ...opts.jobOptions, jobId: job.id })
        result.requeued.push(messageId)
      } else {
        result.dropped.push(messageId)
      }
    }
  }
  if (result.requeued.length || result.dropped.length) {
    opts.logger?.info({ requeued: result.requeued.length, dropped: result.dropped.length }, 'recovered orphan queue jobs')
  }
  return result
}
