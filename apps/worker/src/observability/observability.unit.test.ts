import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { attachMetrics, createMetrics, runWithLogContext } from '@wsm/core'
import type { SessionManager } from '../sessions'
import { createWorkerLogger } from './logger'
import { startObservabilityServer, type ObservabilityServer } from './server'

let server: ObservabilityServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('startObservabilityServer', () => {
  it('port 0: url com a porta real; /health 200 e /metrics Prometheus', async () => {
    const metrics = createMetrics()
    metrics.disconnects.inc({ session: 's1' })
    server = await startObservabilityServer({ port: 0, host: '127.0.0.1', metrics })
    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
    const health = await fetch(`${server.url}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    const res = await fetch(`${server.url}/metrics`)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await res.text()).toContain('wsm_disconnects_total{session="s1"} 1')
    expect((await fetch(`${server.url}/nada`)).status).toBe(404)
  })

  it('/health 503 quando o check falha ou lança', async () => {
    let mode: 'ok' | 'down' | 'throw' = 'down'
    server = await startObservabilityServer({
      port: 0,
      host: '127.0.0.1',
      check: () => {
        if (mode === 'throw') throw new Error('x')
        return mode === 'ok'
      },
    })
    expect((await fetch(`${server.url}/health`)).status).toBe(503)
    mode = 'throw'
    expect((await fetch(`${server.url}/health`)).status).toBe(503)
    mode = 'ok'
    expect((await fetch(`${server.url}/health`)).status).toBe(200)
  })
})

describe('createWorkerLogger', () => {
  it('JSON com service worker, session_id do contexto e redação', () => {
    const lines: Record<string, unknown>[] = []
    const destination = new Writable({
      write(chunk, _enc, cb) {
        for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>)
        cb()
      },
    })
    const log = createWorkerLogger({ destination })
    runWithLogContext({ session_id: 's9' }, () => log.info({ keys: { a: 1 }, token: 't' }, 'x'))
    expect(lines[0]).toMatchObject({ service: 'worker', session_id: 's9', keys: '[Redacted]', token: '[Redacted]' })
  })
})

it('tipos: SessionManager é aceito por attachMetrics', () => {
  const manager = new EventEmitter() as unknown as SessionManager
  const detach = attachMetrics({ metrics: createMetrics(), manager })
  detach()
})
