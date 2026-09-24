import { describe, expect, it } from 'vitest'
import { exec, extractJson, fileExists, tail } from '../helpers/exec'
import { COMPOSE_SERVICES } from './workspaces'

// Sem Docker daemon no ambiente: `docker compose config` só precisa do CLI.
describe('T00 — docker compose', () => {
  it('AC-T00-03 docker-compose.yml existe e docker compose config é válido (exit 0)', () => {
    expect(fileExists('docker-compose.yml')).toBe(true)
    const r = exec('docker compose config -q')
    expect(r.code, tail(r)).toBe(0)
  })

  it('AC-T00-03 docker compose declara os serviços dashboard, api, worker, postgres e redis', () => {
    const r = exec('docker compose config --format json')
    expect(r.code, tail(r)).toBe(0)
    const config = extractJson<{ services?: Record<string, unknown> }>(r.stdout)
    const services = Object.keys(config.services ?? {})
    for (const s of COMPOSE_SERVICES) expect(services, `serviço "${s}" ausente`).toContain(s)
  })

  it('AC-T00-03 docker compose config --services lista os 5 serviços', () => {
    const r = exec('docker compose config --services')
    expect(r.code, tail(r)).toBe(0)
    const services = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    for (const s of COMPOSE_SERVICES) expect(services).toContain(s)
  })
})
