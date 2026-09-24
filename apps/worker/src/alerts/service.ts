// T11 — alertas no worker: consome o evento `alert` do HealthMonitor (T10) e `proxy_unavailable` do verificador
// de proxies (T06) e entrega pelos webhooks configurados. Falhas de entrega nunca derrubam o worker.
import { EventEmitter } from 'node:events'
import { eq } from 'drizzle-orm'
import {
  AlertDispatcher,
  logger as coreLogger,
  type AlertDispatcherOptions,
  type AlertInput,
  type AlertLogger,
  type DeliveryFailure,
  type DispatchResult,
  type ProxyUnavailableEvent,
} from '@wsm/core'
import { sessions } from '@wsm/db'

/** Fonte do evento `alert` (HealthMonitor do T10). */
export interface AlertSource {
  on(event: 'alert', cb: (alert: AlertInput) => void): unknown
  off(event: 'alert', cb: (alert: AlertInput) => void): unknown
}

/** Fonte do evento `proxy_unavailable` (ProxyChecker do T06). */
export interface ProxyUnavailableSource {
  on(event: 'proxy_unavailable', cb: (evt: ProxyUnavailableEvent) => void): unknown
  off(event: 'proxy_unavailable', cb: (evt: ProxyUnavailableEvent) => void): unknown
}

export type AlertServiceOptions = AlertDispatcherOptions & {
  /** Dispatcher pronto (senão é criado com as mesmas opções). */
  dispatcher?: AlertDispatcher
}

export interface AlertServiceEvents {
  delivery_failed: [DeliveryFailure]
  notified: [{ alert: AlertInput; result: DispatchResult }]
}

export class AlertService extends EventEmitter<AlertServiceEvents> {
  readonly dispatcher: AlertDispatcher
  private readonly log: AlertLogger
  private readonly pending = new Set<Promise<unknown>>()
  private readonly detachers: Array<() => void> = []

  constructor(private readonly opts: AlertServiceOptions) {
    super()
    this.log = opts.logger ?? safeChild() ?? { info() {}, warn() {}, error() {} }
    this.dispatcher = opts.dispatcher ?? new AlertDispatcher({ ...opts, logger: this.log })
    const forward = (f: DeliveryFailure) => {
      try {
        this.emit('delivery_failed', f)
      } catch (err) {
        this.log.error({ err: err instanceof Error ? err.message : String(err) }, 'delivery_failed listener threw')
      }
    }
    this.dispatcher.on('delivery_failed', forward)
    this.detachers.push(() => this.dispatcher.off('delivery_failed', forward))
  }

  /** Entrega o alerta (dedup + retries). Nunca lança; resolve após todas as tentativas. */
  notify(alert: AlertInput): Promise<DispatchResult> {
    const p = this.dispatcher.dispatch(alert).then((result) => {
      this.emit('notified', { alert, result })
      return result
    })
    return this.track(p.catch(() => ({ deduped: false, deliveries: [] })))
  }

  /** Assina `alert` do HealthMonitor (T10). */
  attachHealthMonitor(monitor: AlertSource): () => void {
    const listener = (alert: AlertInput) => void this.notify(alert)
    monitor.on('alert', listener)
    const detach = () => void monitor.off('alert', listener)
    this.detachers.push(detach)
    return detach
  }

  /** Assina `proxy_unavailable` do ProxyChecker (T06). */
  attachProxyChecker(checker: ProxyUnavailableSource): () => void {
    const listener = (evt: ProxyUnavailableEvent) => void this.onProxyUnavailable(evt)
    checker.on('proxy_unavailable', listener)
    const detach = () => void checker.off('proxy_unavailable', listener)
    this.detachers.push(detach)
    return detach
  }

  /**
   * Um alerta `proxy_unavailable` por sessão vinculada ao proxy; sem sessão, um alerta com sessionId null.
   * Pode ser passado direto em `startProxyMonitor({ onUnavailable })`.
   */
  readonly onProxyUnavailable = (evt: ProxyUnavailableEvent): Promise<DispatchResult[]> => {
    const run = async () => {
      const detail = { proxyId: evt.proxyId, error: evt.error, errorCount: evt.errorCount }
      const at = evt.checkedAt instanceof Date ? evt.checkedAt : undefined
      let ids: string[] = []
      try {
        ids = (await this.opts.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.proxyId, evt.proxyId))).map((r) => r.id)
      } catch (err) {
        this.log.error({ proxy_id: evt.proxyId, err: err instanceof Error ? err.message : String(err) }, 'proxy session lookup failed')
      }
      const targets = ids.length > 0 ? ids : [null]
      return Promise.all(targets.map((sessionId) => this.notify({ type: 'proxy_unavailable', sessionId, detail, ...(at ? { at } : {}) })))
    }
    return this.track(run().catch(() => []))
  }

  /** Resolve quando não há entregas pendentes. */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  /** Alias de `whenIdle`. */
  idle(): Promise<void> {
    return this.whenIdle()
  }

  /** Remove as assinaturas (entregas em andamento terminam normalmente). */
  stop(): void {
    for (const d of this.detachers.splice(0)) d()
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p)
    void p.finally(() => this.pending.delete(p))
    return p
  }
}

export interface AttachAlertsOptions {
  dispatcher: AlertDispatcher
  healthMonitor?: AlertSource
  proxyChecker?: ProxyUnavailableSource
  logger?: AlertLogger
}

/** Liga HealthMonitor e ProxyChecker a um dispatcher. `idle()` espera as entregas em andamento. */
export function attachAlerts(opts: AttachAlertsOptions): { service: AlertService; stop(): void; idle(): Promise<void> } {
  const service = new AlertService({
    db: opts.dispatcher.webhooks.db,
    dispatcher: opts.dispatcher,
    ...(opts.logger ? { logger: opts.logger } : {}),
  })
  if (opts.healthMonitor) service.attachHealthMonitor(opts.healthMonitor)
  if (opts.proxyChecker) service.attachProxyChecker(opts.proxyChecker)
  return { service, stop: () => service.stop(), idle: () => service.whenIdle() }
}

function safeChild(): AlertLogger | undefined {
  try {
    return coreLogger?.child({ component: 'alerts' })
  } catch {
    return undefined
  }
}
