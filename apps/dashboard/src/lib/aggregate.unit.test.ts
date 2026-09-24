import { describe, expect, it } from 'vitest'
import { appendSample, bucketMessages, formatDateTime, latencySeries, parsePrometheusLatency, summarizeHome } from './aggregate'
import type { Message, MessageStatus, Session, SessionHealth, SessionState } from './types'

const session = (id: string, status: SessionState): Session => ({
  id,
  name: id,
  phone: '+5511999990001',
  status,
  state: status,
  proxyId: null,
  note: null,
  requiresRestart: false,
  warmupStartedAt: null,
  lastConnectedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

const health = (over: Partial<SessionHealth> = {}): SessionHealth => ({
  state: 'STABLE',
  warmupPercent: 100,
  score: 100,
  label: 'Good',
  sent: 0,
  received: 0,
  failed: 0,
  disconnects: 0,
  forbidden403: 0,
  lastEventAt: null,
  ...over,
})

let seq = 0
const msg = (status: MessageStatus, createdAt: Date, sentAt?: Date): Message => ({
  id: `m${++seq}`,
  sessionId: 's',
  contactId: null,
  phone: '+5511999990002',
  content: { text: 'x' },
  status,
  attempts: 1,
  lastError: null,
  transportMessageId: null,
  sentAt: sentAt ? sentAt.toISOString() : null,
  deliveredAt: null,
  readAt: null,
  createdAt: createdAt.toISOString(),
  updatedAt: createdAt.toISOString(),
})

describe('summarizeHome (8 cards)', () => {
  it('conta estados e soma o health', () => {
    const sessions = [
      session('a', 'NEW'),
      session('b', 'WARMING'),
      session('c', 'STABLE'),
      session('d', 'DEGRADED'),
      session('e', 'PAUSED'),
      session('f', 'DISCONNECTED'),
    ]
    const h = {
      b: health({ state: 'WARMING', sent: 3, received: 1, lastEventAt: '2026-01-02T10:00:00.000Z' }),
      c: health({ sent: 5, failed: 1, label: 'Warning', score: 60, lastEventAt: '2026-01-03T10:00:00.000Z' }),
      d: health({ state: 'DEGRADED', label: 'Warning', score: 55, received: 2 }),
      e: undefined,
    }
    expect(summarizeHome(sessions, h)).toEqual({
      connected: 4,
      disconnected: 2,
      warming: 1,
      risk: 2,
      sent: 8,
      received: 3,
      failed: 1,
      lastEventAt: '2026-01-03T10:00:00.000Z',
    })
  })

  it('vazio', () => {
    expect(summarizeHome([], {})).toEqual({ connected: 0, disconnected: 0, warming: 0, risk: 0, sent: 0, received: 0, failed: 0, lastEventAt: null })
  })
})

describe('bucketMessages', () => {
  const now = new Date(2026, 4, 10, 15, 30) // local
  it('por hora: 24 buckets, enviadas pelo sentAt e falhas pelo createdAt', () => {
    const b = bucketMessages(
      [
        msg('sent', new Date(2026, 4, 10, 14, 59), new Date(2026, 4, 10, 15, 1)),
        msg('delivered', new Date(2026, 4, 10, 15, 5), new Date(2026, 4, 10, 15, 6)),
        msg('failed', new Date(2026, 4, 10, 13, 10)),
        msg('queued', new Date(2026, 4, 10, 15, 10)),
        // recebida: status read sem sentAt → não conta como enviada
        msg('read', new Date(2026, 4, 10, 15, 12)),
        msg('sent', new Date(2026, 4, 8, 10, 0), new Date(2026, 4, 8, 10, 0)), // fora da janela
      ],
      { now, unit: 'hour', count: 24 },
    )
    expect(b).toHaveLength(24)
    const last = b.at(-1)!
    expect(last).toMatchObject({ label: '15h', sent: 2, total: 3, failed: 0 })
    expect(b.at(-2)).toMatchObject({ label: '14h', sent: 0, total: 1 })
    expect(b.at(-3)).toMatchObject({ label: '13h', failed: 1, total: 1 })
    expect(b.reduce((n, x) => n + x.sent, 0)).toBe(2)
  })

  it('por dia: 7 buckets', () => {
    const b = bucketMessages(
      [msg('read', new Date(2026, 4, 9, 23, 0), new Date(2026, 4, 9, 23, 0)), msg('failed', new Date(2026, 4, 4, 8, 0))],
      { now, unit: 'day', count: 7 },
    )
    expect(b.map((x) => x.label)).toEqual(['04/05', '05/05', '06/05', '07/05', '08/05', '09/05', '10/05'])
    expect(b[5]).toMatchObject({ sent: 1 })
    expect(b[0]).toMatchObject({ failed: 1 })
  })
})

describe('latência', () => {
  it('sentAt − createdAt das enviadas, em ordem de envio', () => {
    const t = new Date(2026, 0, 1, 10, 0, 0)
    const at = (ms: number) => new Date(t.getTime() + ms)
    const series = latencySeries([
      msg('sent', at(0), at(1500)),
      msg('read', at(100), at(400)),
      msg('failed', at(0)),
      msg('queued', at(0)),
    ])
    expect(series.map((p) => p.ms)).toEqual([300, 1500])
  })

  it('parsePrometheusLatency: histograma em segundos, filtrando pela sessão', () => {
    const text = [
      '# HELP wsm_send_latency_seconds Send latency',
      '# TYPE wsm_send_latency_seconds histogram',
      'wsm_send_latency_seconds_bucket{session="s1",le="0.5"} 1',
      'wsm_send_latency_seconds_sum{session="s1"} 1.5',
      'wsm_send_latency_seconds_count{session="s1"} 3',
      'wsm_send_latency_seconds_sum{session="s2"} 10',
      'wsm_send_latency_seconds_count{session="s2"} 2',
      'wsm_messages_sent_total{session="s1"} 3',
    ].join('\n')
    expect(parsePrometheusLatency(text, 's1')).toEqual({ metric: 'wsm_send_latency_seconds', avgMs: 500, count: 3 })
    expect(parsePrometheusLatency(text)).toEqual({ metric: 'wsm_send_latency_seconds', avgMs: 2300, count: 5 })
    expect(parsePrometheusLatency(text, 'outra')).toMatchObject({ avgMs: 2300 })
    expect(parsePrometheusLatency('wsm_messages_sent_total 1')).toBeNull()
    expect(parsePrometheusLatency('')).toBeNull()
  })
})

describe('utilitários', () => {
  it('appendSample limita a série', () => {
    let s: number[] = []
    for (let i = 0; i < 5; i++) s = appendSample(s, i, 3)
    expect(s).toEqual([2, 3, 4])
  })

  it('formatDateTime', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('lixo')).toBe('—')
    expect(formatDateTime(new Date(2026, 1, 3, 4, 5, 6).toISOString())).toBe('03/02/2026 04:05:06')
  })
})
