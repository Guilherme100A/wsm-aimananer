// AC-T15-02 — todos os serviços do docker-compose.yml têm healthcheck.
import { describe, expect, it } from 'vitest'
import * as core from '@wsm/core'
import * as worker from '@wsm/worker'
import { exec, extractJson, tail } from '../helpers/exec'
import { sample } from './shared'

describe('T15 — healthchecks do compose', () => {
  it('AC-T15-02 docker compose config é válido e todo serviço declara healthcheck ativo', () => {
    const q = exec('docker compose config -q', { timeoutMs: 120_000 })
    expect(q.code, tail(q)).toBe(0)
    const r = exec('docker compose config --format json', { timeoutMs: 120_000 })
    expect(r.code, tail(r)).toBe(0)
    const cfg = extractJson<any>(r.stdout)
    const services = Object.entries<any>(cfg.services ?? {})
    expect(services.map(([n]) => n).sort()).toEqual(expect.arrayContaining(['api', 'dashboard', 'postgres', 'redis', 'worker']))
    for (const [name, svc] of services) {
      const hc = svc.healthcheck
      expect(hc, `serviço ${name} sem healthcheck`).toBeTruthy()
      expect(hc.disable, `healthcheck de ${name} desabilitado`).not.toBe(true)
      const test = Array.isArray(hc.test) ? hc.test : [hc.test]
      expect(test.filter(Boolean).length, `healthcheck.test de ${name}`).toBeGreaterThan(0)
      expect(test[0], `healthcheck.test de ${name}`).not.toBe('NONE')
    }
  })

  it('AC-T15-02 o servidor de observabilidade do worker (alvo do healthcheck) responde /health e /metrics', async () => {
    const start = (worker as any).startObservabilityServer
    expect(typeof start, '@wsm/worker deve exportar startObservabilityServer').toBe('function')
    const metrics = (core as any).createMetrics()
    metrics.messagesSent.inc({ session: 'obs' })
    const srv = await start({ port: 0, host: '127.0.0.1', metrics })
    try {
      expect(String(srv.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)
      expect(String(srv.url)).not.toMatch(/:0\/?$/)
      const base = String(srv.url).replace(/\/$/, '')
      const health = await fetch(`${base}/health`)
      expect(health.status).toBe(200)
      const m = await fetch(`${base}/metrics`)
      expect(m.status).toBe(200)
      expect(sample(await m.text(), 'wsm_messages_sent_total', { session: 'obs' })).toBe(1)
    } finally {
      await srv.close()
    }
  })

  it('AC-T15-02 o healthcheck do worker responde 503 quando o check falha', async () => {
    const srv = await (worker as any).startObservabilityServer({ port: 0, host: '127.0.0.1', check: async () => false })
    try {
      const res = await fetch(`${String(srv.url).replace(/\/$/, '')}/health`)
      expect(res.status).toBe(503)
    } finally {
      await srv.close()
    }
  })
})
