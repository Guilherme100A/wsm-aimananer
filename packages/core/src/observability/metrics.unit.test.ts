import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { attachMetrics, createMetrics } from './metrics'
import { createServiceLogger, runWithLogContext, withSessionLogger } from './log-context'

const S = 'sess-1'

function valueOf(text: string, line: string): number | undefined {
  const row = text.split('\n').find((l) => l.startsWith(`${line} `))
  return row === undefined ? undefined : Number(row.slice(line.length + 1))
}

describe('createMetrics', () => {
  it('expõe todas as séries com registry próprio (instâncias não conflitam)', async () => {
    const a = createMetrics()
    const b = createMetrics()
    expect(a.registry).not.toBe(b.registry)
    a.messagesSent.inc({ session: S })
    a.messagesFailed.inc({ session: S })
    a.disconnects.inc({ session: S })
    a.addQueueDepth(S, 2)
    a.sendLatency.observe(0.2)
    a.setSessionState(S, 'WARMING')
    const text = await a.render()
    expect(valueOf(text, `wsm_messages_sent_total{session="${S}"}`)).toBe(1)
    expect(valueOf(text, `wsm_messages_failed_total{session="${S}"}`)).toBe(1)
    expect(valueOf(text, `wsm_disconnects_total{session="${S}"}`)).toBe(1)
    expect(valueOf(text, `wsm_queue_depth{session="${S}"}`)).toBe(2)
    expect(valueOf(text, 'wsm_send_latency_seconds_count')).toBe(1)
    expect(text).toContain('# TYPE wsm_send_latency_seconds histogram')
    expect(valueOf(text, `wsm_session_state{session="${S}",state="WARMING"}`)).toBe(1)
    expect(valueOf(text, `wsm_session_state{session="${S}",state="PAUSED"}`)).toBe(0)
    expect(a.contentType).toMatch(/^text\/plain/)
    expect(await b.render()).not.toContain(`session="${S}"`)
  })

  it('profundidade nunca fica negativa', async () => {
    const m = createMetrics()
    m.addQueueDepth(S, -3)
    expect(valueOf(await m.render(), `wsm_queue_depth{session="${S}"}`)).toBe(0)
  })

  it('fonte de profundidade consultada no scrape zera sessões que saíram', async () => {
    const m = createMetrics()
    let counts: Record<string, number> = { a: 3, b: 1 }
    m.setQueueDepthSource(async () => counts)
    let text = await m.render()
    expect(valueOf(text, 'wsm_queue_depth{session="a"}')).toBe(3)
    counts = { a: 1 }
    text = await m.render()
    expect(valueOf(text, 'wsm_queue_depth{session="a"}')).toBe(1)
    expect(valueOf(text, 'wsm_queue_depth{session="b"}')).toBe(0)
  })
})

describe('attachMetrics (eventos)', () => {
  it('fila: sent/failed/latência/profundidade; manager: state e quedas não locais', async () => {
    const m = createMetrics({ latencyBuckets: [0.1, 1] })
    const queue = new EventEmitter()
    const manager = new EventEmitter()
    let t = 0
    const detach = attachMetrics({ metrics: m, queue, manager, now: () => t })
    await detach.ready
    const st = (messageId: string, from: string | null, to: string) => queue.emit('status', { messageId, sessionId: S, from, to })

    st('m1', null, 'queued')
    st('m2', null, 'queued')
    expect(valueOf(await m.render(), `wsm_queue_depth{session="${S}"}`)).toBe(2)
    st('m1', 'queued', 'processing')
    t = 500
    st('m1', 'processing', 'sent')
    st('m2', 'queued', 'processing')
    st('m2', 'processing', 'retrying')
    expect(valueOf(await m.render(), `wsm_queue_depth{session="${S}"}`)).toBe(1)
    st('m2', 'retrying', 'processing')
    st('m2', 'processing', 'failed')

    manager.emit('state', { sessionId: S, from: 'NEW', to: 'WARMING' })
    manager.emit('disconnected', { sessionId: S, reason: 'transient' })
    manager.emit('disconnected', { sessionId: S, reason: 'local' })

    const text = await m.render()
    expect(valueOf(text, `wsm_messages_sent_total{session="${S}"}`)).toBe(1)
    expect(valueOf(text, `wsm_messages_failed_total{session="${S}"}`)).toBe(1)
    expect(valueOf(text, `wsm_queue_depth{session="${S}"}`)).toBe(0)
    expect(valueOf(text, 'wsm_send_latency_seconds_count')).toBe(1)
    expect(valueOf(text, 'wsm_send_latency_seconds_sum')).toBe(0.5)
    expect(valueOf(text, 'wsm_send_latency_seconds_bucket{le="1"}')).toBe(1)
    expect(valueOf(text, `wsm_session_state{session="${S}",state="WARMING"}`)).toBe(1)
    expect(valueOf(text, `wsm_disconnects_total{session="${S}"}`)).toBe(1)

    detach()
    expect(queue.listenerCount('status')).toBe(0)
    expect(manager.listenerCount('state')).toBe(0)
    expect(manager.listenerCount('disconnected')).toBe(0)
  })

  it('aceita a forma attachMetrics(metrics, { sessions })', () => {
    const m = createMetrics()
    const sessions = new EventEmitter()
    const detach = attachMetrics(m, { sessions })
    expect(sessions.listenerCount('state')).toBe(1)
    detach.detach()
    expect(sessions.listenerCount('state')).toBe(0)
  })
})

describe('logger de serviço', () => {
  function capture() {
    const lines: Record<string, unknown>[] = []
    const raw: string[] = []
    const destination = new Writable({
      write(chunk, _enc, cb) {
        for (const l of String(chunk).split('\n').filter(Boolean)) {
          raw.push(l)
          lines.push(JSON.parse(l) as Record<string, unknown>)
        }
        cb()
      },
    })
    return { lines, raw, destination }
  }

  it('JSON com service, session_id do contexto e redação de credenciais', () => {
    const { lines, raw, destination } = capture()
    const log = createServiceLogger({ service: 'worker', destination })
    runWithLogContext({ session_id: 'abc' }, () => log.info({ creds: { noiseKey: 'x' }, authorization: 'Bearer t' }, 'hello'))
    log.info('fora')
    withSessionLogger(log, 'xyz').info('fixo')
    runWithLogContext({ session_id: 'ctx' }, () => withSessionLogger(log, 'bound').info('dup'))
    expect(lines[0]).toMatchObject({ service: 'worker', session_id: 'abc', creds: '[Redacted]', authorization: '[Redacted]', msg: 'hello' })
    expect(lines[1]).not.toHaveProperty('session_id')
    expect(lines[2]).toMatchObject({ session_id: 'xyz' })
    expect(lines[3]).toMatchObject({ session_id: 'bound' })
    expect(raw[3]!.match(/"session_id"/g)).toHaveLength(1)
  })
})
