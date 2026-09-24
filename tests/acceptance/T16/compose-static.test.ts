// Checagens estáticas da composição (sem subir containers): `docker compose config` e arquivos de build.
import { describe, expect, it } from 'vitest'
import { exec, fileExists, readText, tail } from '../helpers/exec'
import { PORTS, SERVICES, stackEnv } from './stack'

/** `docker compose config` resolvido como JSON, com o env informado (sem herdar o env de teste do vitest). */
function config(env: Record<string, string>) {
  const clean: Record<string, string | undefined> = { ...env }
  for (const k of ['WA_TRANSPORT', 'ANTIBAN_MODE', 'ANTIBAN_PRESET']) if (!(k in env)) clean[k] = ''
  const r = exec('docker compose config --format json', { timeoutMs: 120_000, env: clean as NodeJS.ProcessEnv })
  expect(r.code, tail(r)).toBe(0)
  return JSON.parse(r.stdout) as { services: Record<string, any> }
}

const envOf = (svc: any): Record<string, string> => {
  const e = svc?.environment ?? {}
  if (Array.isArray(e)) return Object.fromEntries(e.map((kv: string) => [kv.split('=')[0], kv.split('=').slice(1).join('=')]))
  return e
}

describe('T16 — composição (estático)', () => {
  it('AC-T16-01 o compose tem exatamente os 5 serviços, todos com healthcheck', () => {
    const cfg = config({})
    expect(Object.keys(cfg.services).sort()).toEqual([...SERVICES].sort())
    for (const s of SERVICES) expect(cfg.services[s].healthcheck?.test, `${s} sem healthcheck`).toBeTruthy()
    for (const s of ['api', 'worker', 'dashboard']) expect(cfg.services[s].build, `${s} sem build`).toBeTruthy()
  })

  it('AC-T16-01 Dockerfiles de api, worker e dashboard existem e há .dockerignore excluindo node_modules, dist e .env', () => {
    for (const app of ['api', 'worker', 'dashboard']) expect(fileExists(`apps/${app}/Dockerfile`), `apps/${app}/Dockerfile`).toBe(true)
    expect(fileExists('.dockerignore'), '.dockerignore ausente').toBe(true)
    const ignore = readText('.dockerignore')
    expect(ignore).toMatch(/node_modules/)
    expect(ignore).toMatch(/dist/)
    expect(ignore).toMatch(/^\.env$|^\.env\b|^\*\*\/\.env/m)
  })

  it('AC-T16-01 portas de host parametrizadas (a stack E2E roda isolada sem colidir com a infra padrão)', () => {
    const cfg = config(stackEnv())
    const published = (s: string) => (cfg.services[s].ports ?? []).map((p: any) => Number(p.published))
    expect(published('postgres')).toContain(PORTS.postgres)
    expect(published('redis')).toContain(PORTS.redis)
    expect(published('api')).toContain(PORTS.api)
    expect(published('dashboard')).toContain(PORTS.dashboard)
    expect(published('worker')).toEqual(expect.arrayContaining([PORTS.workerHealth, PORTS.workerInternal]))
    for (const s of SERVICES) expect(cfg.services[s].container_name, `${s} com container_name fixo`).toBeUndefined()
  })

  it('AC-T16-01 fail-safe: sem configuração, o worker usa baileys e o antiban real (fake/passthrough só por env explícito)', () => {
    const cfg = config({})
    const w = envOf(cfg.services.worker)
    expect(w.WA_TRANSPORT ?? 'baileys').toBe('baileys')
    expect(w.ANTIBAN_MODE ?? 'real').toBe('real')
    const t = envOf(config(stackEnv()).services.worker)
    expect(t.WA_TRANSPORT).toBe('fake')
    expect(t.ANTIBAN_MODE).toBe('passthrough')
  })

  it('AC-T16-01 api fala com o worker pela rede interna (WORKER_INTERNAL_URL) com token interno', () => {
    const cfg = config(stackEnv())
    const a = envOf(cfg.services.api)
    const w = envOf(cfg.services.worker)
    expect(a.WORKER_INTERNAL_URL).toMatch(/^http:\/\/worker:\d+/)
    expect(a.INTERNAL_TOKEN).toBeTruthy()
    expect(a.INTERNAL_TOKEN).toBe(w.INTERNAL_TOKEN)
    expect(a.INTERNAL_TOKEN).not.toBe(a.API_TOKEN)
  })
})
