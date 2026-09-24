// AC-T02-05: o logger pino compartilhado redige credenciais. O output é capturado num processo filho
// (pino escreve direto no fd do stdout), sem depender de detalhes internos do logger.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exec, rootPath, tail, type ExecResult } from '../helpers/exec'

const SECRET_FIELDS = ['creds', 'keys', 'noiseKey', 'signedIdentityKey'] as const

interface ProbeCase {
  id: string
  level: 'info' | 'warn' | 'error'
  child: boolean
  payload: unknown
  marker: string
  field: string
  shape: string
}

const mark = (tag: string) => `LEAK-${tag}-${randomBytes(8).toString('hex')}`

function buildCases(): ProbeCase[] {
  const cases: ProbeCase[] = []
  let n = 0
  for (const field of SECRET_FIELDS) {
    const shapes: Array<[string, (m: string) => unknown]> = [
      ['valor string no topo', (m) => ({ [field]: m })],
      ['objeto aninhado no topo', (m) => ({ [field]: { private: m, public: m, nested: { deep: m } } })],
      ['dentro de outro objeto', (m) => ({ session: { [field]: { private: m } } })],
    ]
    for (const [shape, make] of shapes) {
      for (const child of [false, true]) {
        const marker = mark(`${field}-${n}`)
        cases.push({ id: `c${n++}`, level: n % 3 === 0 ? 'error' : n % 3 === 1 ? 'info' : 'warn', child, payload: make(marker), marker, field, shape })
      }
    }
  }
  // Formatos típicos do Baileys: creds completas e keys por tipo.
  const credsMarker = mark('creds-full')
  cases.push({
    id: `c${n++}`,
    level: 'info',
    child: false,
    marker: credsMarker,
    field: 'creds',
    shape: 'creds com noiseKey/signedIdentityKey/advSecretKey',
    payload: { creds: { noiseKey: { private: credsMarker }, signedIdentityKey: { private: credsMarker }, advSecretKey: credsMarker, me: { id: 'x@s.whatsapp.net' } } },
  })
  const keysMarker = mark('keys-full')
  cases.push({
    id: `c${n++}`,
    level: 'info',
    child: true,
    marker: keysMarker,
    field: 'keys',
    shape: "keys { 'pre-key': {...}, session: {...} }",
    payload: { keys: { 'pre-key': { '1': { private: keysMarker } }, session: { 'peer.0': keysMarker } } },
  })
  return cases
}

let cases: ProbeCase[]
let run: ExecResult
let dir: string

beforeAll(() => {
  cases = buildCases()
  dir = mkdtempSync(join(tmpdir(), 'wsm-t02-log-'))
  const file = join(dir, 'cases.json')
  writeFileSync(file, JSON.stringify(cases.map(({ id, level, child, payload }) => ({ id, level, child, payload }))))
  const probe = rootPath('tests/acceptance/T02/fixtures/log-probe.mts')
  run = exec(`node --import tsx "${probe}" "${file}"`, {
    timeoutMs: 120_000,
    env: { LOG_LEVEL: 'info', NODE_ENV: 'production', CREDENTIALS_KEY: randomBytes(32).toString('base64') },
  })
}, 180_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('T02 — logger com redação', () => {
  it('AC-T02-05 o logger compartilhado do @wsm/core carrega e escreve os logs (sanidade)', () => {
    expect(run.code, tail(run)).toBe(0)
    for (const c of cases) expect(run.output, `log "probe:${c.id}" não foi emitido`).toContain(`probe:${c.id}`)
  })

  for (const field of SECRET_FIELDS) {
    it(`AC-T02-05 logar objeto com "${field}" não produz o valor no output`, () => {
      expect(run.code, tail(run)).toBe(0)
      const leaks = cases.filter((c) => c.field === field && run.output.includes(c.marker)).map((c) => `${c.shape}${c.child ? ' (child logger)' : ''}`)
      expect(leaks, `valor de "${field}" vazou no log em: ${leaks.join('; ')}`).toEqual([])
    })
  }

  it('AC-T02-05 creds e keys no formato do Baileys são redigidas por inteiro', () => {
    const full = cases.filter((c) => c.shape.includes('{'))
    for (const c of full) expect(run.output.includes(c.marker), `vazou: ${c.shape}`).toBe(false)
  })
})
