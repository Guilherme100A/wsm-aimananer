// Utilidades compartilhadas pelos testes do T02 (cripto de credenciais e auth state no Postgres).
import { randomBytes } from 'node:crypto'
import { vi } from 'vitest'

/** Chave válida no formato de CREDENTIALS_KEY (SPEC 3.5): 32 bytes em base64. */
export const newKey = () => randomBytes(32).toString('base64')

type Core = Record<string, any>

/**
 * Importa um @wsm/core "recém-inicializado" com o CREDENTIALS_KEY dado (`undefined` = ausente).
 * `vi.resetModules()` garante que nenhum estado de módulo (chave em cache) sobreviva entre cargas.
 */
export async function loadCoreWithKey(key: string | undefined): Promise<Core> {
  if (key === undefined) delete process.env.CREDENTIALS_KEY
  else process.env.CREDENTIALS_KEY = key
  vi.resetModules()
  return (await import('@wsm/core')) as Core
}

export function cryptoApi(core: Core) {
  const { encrypt, decrypt } = core
  if (typeof encrypt !== 'function' || typeof decrypt !== 'function') throw new Error('@wsm/core não exporta encrypt/decrypt')
  return { encrypt: encrypt as (x: unknown) => any, decrypt: decrypt as (e: any) => any }
}

/** Preserva e restaura CREDENTIALS_KEY do processo. */
export function preserveKeyEnv() {
  const original = process.env.CREDENTIALS_KEY
  return () => {
    if (original === undefined) delete process.env.CREDENTIALS_KEY
    else process.env.CREDENTIALS_KEY = original
    vi.resetModules()
  }
}

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array

/** Converte qualquer valor em Buffer, preservando o formato (base64/hex/bytes) para reconverter depois. */
function toBytes(v: unknown): { bytes: Buffer; back: (b: Buffer) => unknown } {
  if (isBytes(v)) return { bytes: Buffer.from(v), back: (b) => (Buffer.isBuffer(v) ? b : new Uint8Array(b)) }
  if (typeof v === 'string') {
    if (/^[0-9a-f]+$/i.test(v) && v.length % 2 === 0) return { bytes: Buffer.from(v, 'hex'), back: (b) => b.toString('hex') }
    const url = /[-_]/.test(v)
    return { bytes: Buffer.from(v, url ? 'base64url' : 'base64'), back: (b) => b.toString(url ? 'base64url' : 'base64') }
  }
  throw new Error(`campo cifrado em formato inesperado: ${typeof v}`)
}

export type Part = 'ciphertext' | 'iv' | 'authTag'

const PART_KEYS: Record<Part, RegExp> = {
  ciphertext: /^(cipher_?text|ct|data|encrypted)$/i,
  iv: /^(iv|nonce)$/i,
  authTag: /^(auth_?tag|tag)$/i,
}

/** Localiza o campo de um envelope cifrado (objeto { ciphertext, iv, authTag, ... }). */
export function partKey(envelope: Record<string, unknown>, part: Part): string {
  const key = Object.keys(envelope).find((k) => PART_KEYS[part].test(k))
  if (!key) throw new Error(`envelope sem campo ${part}: chaves = ${Object.keys(envelope).join(', ')}`)
  return key
}

/** Posição (no blob empacotado) usada quando encrypt devolve um único Buffer/string. */
const PACKED_POS: Record<Part, (len: number) => number> = { iv: () => 0, ciphertext: (n) => Math.floor(n / 2), authTag: (n) => n - 1 }

/** Cópia do envelope com 1 bit trocado na parte indicada. */
export function tamper(envelope: unknown, part: Part): unknown {
  if (envelope && typeof envelope === 'object' && !isBytes(envelope)) {
    const e = { ...(envelope as Record<string, unknown>) }
    const k = partKey(e, part)
    const { bytes, back } = toBytes(e[k])
    const copy = Buffer.from(bytes)
    copy[Math.floor(copy.length / 2)] ^= 0x01
    e[k] = back(copy)
    return e
  }
  const { bytes, back } = toBytes(envelope)
  const copy = Buffer.from(bytes)
  copy[PACKED_POS[part](copy.length)] ^= 0x01
  return back(copy)
}

/** Todo o material do envelope como bytes (para procurar o texto puro dentro dele). */
export function envelopeBytes(envelope: unknown): Buffer[] {
  if (envelope && typeof envelope === 'object' && !isBytes(envelope)) {
    return Object.values(envelope as Record<string, unknown>).flatMap((v) => (isBytes(v) || typeof v === 'string' ? [toBytes(v).bytes, Buffer.from(String(v))] : []))
  }
  return [toBytes(envelope).bytes]
}

export { toBytes }

/** Normaliza bytes (Buffer/Uint8Array) em hex para comparação profunda estável. */
export function normalize(v: unknown): unknown {
  if (isBytes(v)) return { $bytes: Buffer.from(v).toString('hex') }
  if (v && typeof v === 'object' && (v as any).type === 'Buffer' && Array.isArray((v as any).data)) return { $bytes: Buffer.from((v as any).data).toString('hex') }
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, normalize(x)]),
    )
  }
  return v
}
