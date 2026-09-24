// Métricas Prometheus (T15, AC-T15-01). Cada instância tem o próprio Registry (nunca o global do prom-client),
// então várias instâncias convivem no mesmo processo (testes, api + worker juntos).
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'
import { inArray, sql } from 'drizzle-orm'
import { messages, sessions, type Database } from '@wsm/db'
import { SESSION_STATES, type SessionState } from '../session/states'
import type { MessageStatus } from '../queue/states'

export const DEFAULT_LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]

/** Estados que contam como "na fila" para `wsm_queue_depth`. */
export const QUEUE_DEPTH_STATUSES: readonly MessageStatus[] = ['queued', 'retrying']

export interface CreateMetricsOptions {
  /** Registry a usar (default: um novo por instância). */
  registry?: Registry
  /** Inclui as métricas padrão do processo (CPU, memória, event loop). Default false. */
  collectDefaultMetrics?: boolean
  latencyBuckets?: number[]
}

export type QueueDepthSource = () => Promise<Record<string, number>>

export interface WsmMetrics {
  readonly registry: Registry
  /** Content-Type da exposição (texto Prometheus 0.0.4). */
  readonly contentType: string
  readonly messagesSent: Counter<'session'>
  readonly messagesFailed: Counter<'session'>
  readonly disconnects: Counter<'session'>
  readonly queueDepth: Gauge<'session'>
  readonly sendLatency: Histogram
  readonly sessionState: Gauge<'session' | 'state'>
  /** Texto da exposição Prometheus. */
  render(): Promise<string>
  /** 1 no estado atual e 0 nos demais estados da SPEC 3.2. */
  setSessionState(sessionId: string, state: SessionState): void
  /** Ajusta a profundidade da fila da sessão (nunca abaixo de 0). */
  addQueueDepth(sessionId: string, delta: number): void
  /** Fonte exata da profundidade, consultada a cada scrape (ex.: banco). `undefined` volta ao modo por eventos. */
  setQueueDepthSource(source: QueueDepthSource | undefined): void
}

export function createMetrics(opts: CreateMetricsOptions = {}): WsmMetrics {
  const registry = opts.registry ?? new Registry()
  if (opts.collectDefaultMetrics) collectDefaultMetrics({ register: registry })
  const registers = [registry]
  const depth = new Map<string, number>()
  let depthSource: QueueDepthSource | undefined

  const messagesSent = new Counter({
    name: 'wsm_messages_sent_total',
    help: 'Mensagens entregues ao transporte (status sent), por sessão.',
    labelNames: ['session'] as const,
    registers,
  })
  const messagesFailed = new Counter({
    name: 'wsm_messages_failed_total',
    help: 'Mensagens que esgotaram as tentativas (status failed), por sessão.',
    labelNames: ['session'] as const,
    registers,
  })
  const disconnects = new Counter({
    name: 'wsm_disconnects_total',
    help: 'Quedas de conexão da sessão (loggedOut, forbidden ou transitória); encerramentos locais não contam.',
    labelNames: ['session'] as const,
    registers,
  })
  const queueDepth = new Gauge({
    name: 'wsm_queue_depth',
    help: 'Mensagens aguardando envio (queued + retrying), por sessão.',
    labelNames: ['session'] as const,
    registers,
    async collect() {
      if (!depthSource) return
      const counts = await depthSource()
      for (const [session, n] of Object.entries(counts)) depth.set(session, n)
      for (const session of depth.keys()) if (!(session in counts)) depth.set(session, 0)
      for (const [session, n] of depth) this.set({ session }, n)
    },
  })
  const sendLatency = new Histogram({
    name: 'wsm_send_latency_seconds',
    help: 'Tempo de entrega ao transporte (processing → sent), em segundos.',
    buckets: opts.latencyBuckets ?? DEFAULT_LATENCY_BUCKETS,
    registers,
  })
  const sessionState = new Gauge({
    name: 'wsm_session_state',
    help: 'Estado atual da sessão: 1 no estado vigente, 0 nos demais.',
    labelNames: ['session', 'state'] as const,
    registers,
  })

  return {
    registry,
    contentType: registry.contentType,
    messagesSent,
    messagesFailed,
    disconnects,
    queueDepth,
    sendLatency,
    sessionState,
    render: () => registry.metrics(),
    setSessionState(sessionId, state) {
      for (const s of SESSION_STATES) sessionState.set({ session: sessionId, state: s }, s === state ? 1 : 0)
    },
    addQueueDepth(sessionId, delta) {
      const n = Math.max(0, (depth.get(sessionId) ?? 0) + delta)
      depth.set(sessionId, n)
      queueDepth.set({ session: sessionId }, n)
    },
    setQueueDepthSource(source) {
      depthSource = source
    },
  }
}

// ---- ligação com a fila (T08) e o SessionManager (T05) -----------------------------------------------

/** Emissor mínimo (EventEmitter). Tipos estruturais: o core não depende do worker. */
/* eslint-disable @typescript-eslint/no-explicit-any -- aceita qualquer EventEmitter tipado (MessageQueue, SessionManager) */
export interface MetricsEventSource {
  on(event: any, listener: (...args: any[]) => void): unknown
  off(event: any, listener: (...args: any[]) => void): unknown
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface AttachMetricsOptions {
  /** MessageQueue (evento `status`). */
  queue?: MetricsEventSource
  /** SessionManager (eventos `state` e `disconnected`). Alias: `sessions`. */
  manager?: MetricsEventSource
  sessions?: MetricsEventSource
  /** Com banco: estado inicial das sessões e profundidade exata da fila a cada scrape. */
  db?: Database
  now?: () => number
}

export interface MetricsAttachment {
  (): void
  detach(): void
  /** Resolve quando o estado inicial (banco) foi carregado. */
  ready: Promise<void>
}

interface StatusEvent {
  messageId: string
  sessionId: string
  from: MessageStatus | null
  to: MessageStatus
}

interface StateEvent {
  sessionId: string
  to: SessionState
}

interface DisconnectedEvent {
  sessionId: string
  reason: string
}

const MAX_INFLIGHT = 10_000

/**
 * Alimenta as métricas pelos eventos já existentes (sem alterar T05/T08).
 * Aceita `attachMetrics(metrics, { queue, manager, db })` ou `attachMetrics({ metrics, queue, manager, db })`.
 */
export function attachMetrics(metrics: WsmMetrics, opts?: AttachMetricsOptions): MetricsAttachment
export function attachMetrics(opts: AttachMetricsOptions & { metrics: WsmMetrics }): MetricsAttachment
export function attachMetrics(
  a: WsmMetrics | (AttachMetricsOptions & { metrics: WsmMetrics }),
  b: AttachMetricsOptions = {},
): MetricsAttachment {
  const { metrics, ...opts } = 'metrics' in a ? a : { metrics: a, ...b }
  const manager = opts.manager ?? opts.sessions
  const now = opts.now ?? (() => performance.now())
  const inflight = new Map<string, number>()
  const cleanups: Array<() => void> = []

  const listen = <T>(source: MetricsEventSource, event: string, fn: (payload: T) => void) => {
    const listener = fn as (...args: unknown[]) => void
    source.on(event, listener)
    cleanups.push(() => source.off(event, listener))
  }

  if (opts.queue) {
    listen<StatusEvent>(opts.queue, 'status', (ev) => {
      const { sessionId: session, messageId } = ev
      const wasWaiting = ev.from !== null && QUEUE_DEPTH_STATUSES.includes(ev.from)
      const isWaiting = QUEUE_DEPTH_STATUSES.includes(ev.to)
      if (wasWaiting !== isWaiting) metrics.addQueueDepth(session, isWaiting ? 1 : -1)
      if (ev.to === 'processing') {
        if (inflight.size >= MAX_INFLIGHT) inflight.clear()
        inflight.set(messageId, now())
      } else if (ev.to === 'sent') {
        metrics.messagesSent.inc({ session })
        const start = inflight.get(messageId)
        if (start !== undefined) metrics.sendLatency.observe((now() - start) / 1000)
        inflight.delete(messageId)
      } else if (ev.to === 'failed') {
        metrics.messagesFailed.inc({ session })
        inflight.delete(messageId)
      } else if (ev.to === 'retrying' || ev.to === 'cancelled') {
        inflight.delete(messageId)
      }
    })
  }

  if (manager) {
    listen<StateEvent>(manager, 'state', (ev) => metrics.setSessionState(ev.sessionId, ev.to))
    listen<DisconnectedEvent>(manager, 'disconnected', (ev) => {
      if (ev.reason !== 'local') metrics.disconnects.inc({ session: ev.sessionId })
    })
  }

  let ready: Promise<void> = Promise.resolve()
  if (opts.db) {
    const db = opts.db
    metrics.setQueueDepthSource(() => queueDepthFromDb(db))
    cleanups.push(() => metrics.setQueueDepthSource(undefined))
    ready = (async () => {
      const rows = await db.select({ id: sessions.id, status: sessions.status }).from(sessions)
      for (const row of rows) metrics.setSessionState(row.id, row.status)
    })()
  }

  let detached = false
  const detach = (() => {
    if (detached) return
    detached = true
    for (const fn of cleanups.splice(0)) fn()
    inflight.clear()
  }) as MetricsAttachment
  detach.detach = detach
  detach.ready = ready
  return detach
}

/** Profundidade exata por sessão: mensagens queued + retrying no banco. */
export async function queueDepthFromDb(db: Database): Promise<Record<string, number>> {
  const rows = await db
    .select({ sessionId: messages.sessionId, n: sql<number>`count(*)::int` })
    .from(messages)
    .where(inArray(messages.status, [...QUEUE_DEPTH_STATUSES]))
    .groupBy(messages.sessionId)
  return Object.fromEntries(rows.map((r) => [r.sessionId, Number(r.n)]))
}
