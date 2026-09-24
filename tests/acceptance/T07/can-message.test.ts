import { describe, expect, it } from 'vitest'
import { canMessage } from '@wsm/core'

/** Contato no formato do @wsm/db (Drizzle, camelCase). */
const contact = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Contato',
  phone: '+5599900000001',
  consent: true,
  consentAt: new Date('2026-09-01T12:00:00Z'),
  consentSource: 'formulario',
  optOut: false,
  lastContactAt: null,
  ...over,
})

async function check(c: unknown) {
  return (await (canMessage as any)(c)) as { ok: boolean; reason?: string }
}

function expectDenied(r: { ok: boolean; reason?: string }) {
  expect(r.ok).toBe(false)
  expect(typeof r.reason, `reason ausente: ${JSON.stringify(r)}`).toBe('string')
  expect(r.reason!.trim().length).toBeGreaterThan(0)
}

describe('T07 — canMessage', () => {
  it('AC-T07-04 canMessage retorna { ok: false, reason } quando opt_out=true', async () => {
    expectDenied(await check(contact({ optOut: true })))
  })

  it('AC-T07-04 canMessage retorna { ok: false, reason } quando consent=false', async () => {
    expectDenied(await check(contact({ consent: false })))
  })

  it('AC-T07-04 canMessage retorna { ok: false, reason } quando o contato não existe', async () => {
    expectDenied(await check(null))
    expectDenied(await check(undefined))
  })

  it('AC-T07-04 opt_out prevalece mesmo com consentimento registrado', async () => {
    expectDenied(await check(contact({ optOut: true, consent: true })))
  })

  it('AC-T07-04 motivos distinguem opt-out, falta de consentimento e contato inexistente', async () => {
    const reasons = new Set([
      (await check(contact({ optOut: true }))).reason,
      (await check(contact({ consent: false }))).reason,
      (await check(null)).reason,
    ])
    expect(reasons.size).toBe(3)
  })

  it('AC-T07-04 canMessage retorna { ok: true } para contato com consentimento e sem opt-out', async () => {
    expect((await check(contact())).ok).toBe(true)
  })
})
