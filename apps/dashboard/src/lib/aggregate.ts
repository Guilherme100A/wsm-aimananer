// Agregações feitas no cliente a partir de /api/sessions, /api/sessions/:id/health, /api/messages e /metrics.
import { CONNECTED_STATES, DISCONNECTED_STATES } from './states'
import type { Message, MessageStatus, Session, SessionHealth } from './types'

export interface HomeSummary {
  connected: number
  disconnected: number
  warming: number
  risk: number
  sent: number
  received: number
  failed: number
  lastEventAt: string | null
}

/**
 * Cards da home (AC-T12-02). Contagens por estado vêm de /api/sessions; enviadas/recebidas/falhas somam o
 * health (janela do Health Monitor) de cada sessão; último evento = maior lastEventAt.
 */
export function summarizeHome(sessions: Session[], health: Record<string, SessionHealth | undefined>): HomeSummary {
  const s: HomeSummary = { connected: 0, disconnected: 0, warming: 0, risk: 0, sent: 0, received: 0, failed: 0, lastEventAt: null }
  for (const session of sessions) {
    const state = session.status
    if (CONNECTED_STATES.includes(state)) s.connected++
    if (DISCONNECTED_STATES.includes(state)) s.disconnected++
    if (state === 'WARMING') s.warming++
    const h = health[session.id]
    if (state === 'DEGRADED' || (h && h.label !== 'Good')) s.risk++
    if (!h) continue
    s.sent += h.sent
    s.received += h.received
    s.failed += h.failed
    if (h.lastEventAt && (!s.lastEventAt || Date.parse(h.lastEventAt) > Date.parse(s.lastEventAt))) s.lastEventAt = h.lastEventAt
  }
  return s
}

export const SENT_STATUSES: readonly MessageStatus[] = ['sent', 'delivered', 'read']

export interface Bucket {
  key: string
  label: string
  sent: number
  failed: number
  total: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
const pad = (n: number) => String(n).padStart(2, '0')

/** Início (local) da hora/dia que contém `t`. */
function floorTo(t: number, unit: 'hour' | 'day'): number {
  const d = new Date(t)
  d.setMinutes(0, 0, 0)
  if (unit === 'day') d.setHours(0)
  return d.getTime()
}

function bucketLabel(t: number, unit: 'hour' | 'day'): string {
  const d = new Date(t)
  return unit === 'hour' ? `${pad(d.getHours())}h` : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}

/**
 * Mensagens por hora/dia nas últimas `count` unidades até `now` (buckets vazios incluídos).
 * Enviadas contam pelo `sentAt` (só mensagens com sentAt); falhas e total pelo `createdAt`.
 */
export function bucketMessages(messages: Message[], opts: { now: Date; unit: 'hour' | 'day'; count: number }): Bucket[] {
  const step = opts.unit === 'hour' ? HOUR : DAY
  const last = floorTo(opts.now.getTime(), opts.unit)
  const buckets: Bucket[] = []
  const index = new Map<number, Bucket>()
  for (let i = opts.count - 1; i >= 0; i--) {
    // Para dias, recalcula pelo calendário local (horário de verão não desalinha).
    const start = opts.unit === 'hour' ? last - i * step : floorTo(last - i * step + HOUR * 12, 'day')
    const b: Bucket = { key: new Date(start).toISOString(), label: bucketLabel(start, opts.unit), sent: 0, failed: 0, total: 0 }
    buckets.push(b)
    index.set(start, b)
  }
  const at = (iso: string | null) => (iso ? index.get(floorTo(Date.parse(iso), opts.unit)) : undefined)
  for (const m of messages) {
    const created = at(m.createdAt)
    if (created) {
      created.total++
      if (m.status === 'failed') created.failed++
    }
    // Só envios reais têm sentAt (gravado pela fila): mensagens recebidas não contam como enviadas.
    if (m.sentAt && SENT_STATUSES.includes(m.status)) {
      const sent = at(m.sentAt)
      if (sent) sent.sent++
    }
  }
  return buckets
}

export interface LatencyPoint {
  label: string
  ms: number
}

/** Latência de envio (fila → envio) das mensagens enviadas: sentAt − createdAt, em ordem de envio. */
export function latencySeries(messages: Message[], limit = 50): LatencyPoint[] {
  return messages
    .filter((m) => m.sentAt && SENT_STATUSES.includes(m.status))
    .map((m) => ({ sentAt: Date.parse(m.sentAt!), ms: Math.max(0, Date.parse(m.sentAt!) - Date.parse(m.createdAt)) }))
    .filter((p) => Number.isFinite(p.sentAt) && Number.isFinite(p.ms))
    .sort((a, b) => a.sentAt - b.sentAt)
    .slice(-limit)
    .map((p) => {
      const d = new Date(p.sentAt)
      return { label: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, ms: p.ms }
    })
}

export interface MetricLatency {
  metric: string
  avgMs: number
  count: number
}

/**
 * Latência média a partir do texto Prometheus (T15): primeiro histograma/summary com "latency" no nome
 * (`<nome>_sum` / `<nome>_count`, somando as séries). Unidade em segundos quando o nome contém "seconds".
 * Com `sessionId`, considera só séries com esse label quando houver alguma.
 */
export function parsePrometheusLatency(text: string, sessionId?: string): MetricLatency | null {
  const sums = new Map<string, { all: number; session: number; hasSession: boolean }>()
  const counts = new Map<string, { all: number; session: number; hasSession: boolean }>()
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([-+0-9.eE]+|NaN|\+Inf)/.exec(line.trim())
    if (!m) continue
    const [, name, labels = '', raw] = m
    if (!name || !/latency/i.test(name)) continue
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    const target = name.endsWith('_sum') ? sums : name.endsWith('_count') ? counts : undefined
    if (!target) continue
    const base = name.replace(/_(sum|count)$/, '')
    const entry = target.get(base) ?? { all: 0, session: 0, hasSession: false }
    entry.all += value
    if (sessionId && labels.includes(`"${sessionId}"`)) {
      entry.session += value
      entry.hasSession = true
    }
    target.set(base, entry)
  }
  for (const [metric, sum] of sums) {
    const count = counts.get(metric)
    if (!count) continue
    const useSession = !!sessionId && sum.hasSession && count.hasSession
    const s = useSession ? sum.session : sum.all
    const c = useSession ? count.session : count.all
    if (c <= 0) continue
    const factor = /seconds/i.test(metric) ? 1000 : 1
    return { metric, avgMs: (s / c) * factor, count: c }
  }
  return null
}

/** Acrescenta uma amostra a uma série limitada (séries amostradas por polling). */
export function appendSample<T>(series: T[], sample: T, max = 60): T[] {
  const next = [...series, sample]
  return next.length > max ? next.slice(next.length - max) : next
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function timeLabel(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
