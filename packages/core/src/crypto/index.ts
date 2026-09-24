// Cifragem de credenciais (SPEC T02): AES-256-GCM com chave de 32 bytes vinda de CREDENTIALS_KEY (base64).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const CREDENTIALS_ALGORITHM = 'aes-256-gcm'
export const CREDENTIALS_KEY_BYTES = 32
export const IV_BYTES = 12
export const AUTH_TAG_BYTES = 16
export const DEFAULT_KEY_VERSION = 1

// Primeiro byte do texto claro (dentro do ciphertext) indica o tipo original, para decrypt devolver string ou Buffer.
const KIND_BUFFER = 0x00
const KIND_STRING = 0x01

export type Plaintext = string | Buffer

/** Resultado de `encrypt`. Os campos casam com as colunas bytea (`ciphertext`, `iv`, `auth_tag`) + `key_version`. */
export interface EncryptedPayload<T extends Plaintext = Plaintext> {
  ciphertext: Buffer
  iv: Buffer
  authTag: Buffer
  keyVersion: number
  /** Marca de tipo apenas em tempo de compilação. */
  readonly __plaintext?: T
}

export interface CipherOptions {
  /** Dados autenticados adicionais (ex.: `sessionId/tipo/id`); o mesmo valor é exigido no decrypt. */
  aad?: string | Buffer
}

export class CredentialsKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialsKeyError'
  }
}

export class DecryptionError extends Error {
  constructor(message = 'falha ao decifrar: dados adulterados ou chave incorreta') {
    super(message)
    this.name = 'DecryptionError'
  }
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Decodifica e valida a chave (32 bytes em base64). Lança `CredentialsKeyError` se ausente ou inválida. */
export function parseCredentialsKey(raw: string | undefined): Buffer {
  const value = raw?.trim()
  if (!value) throw new CredentialsKeyError('CREDENTIALS_KEY ausente (32 bytes em base64)')
  if (!BASE64.test(value)) throw new CredentialsKeyError('CREDENTIALS_KEY inválida: não é base64')
  const key = Buffer.from(value, 'base64')
  if (key.length !== CREDENTIALS_KEY_BYTES)
    throw new CredentialsKeyError(
      `CREDENTIALS_KEY inválida: esperado ${CREDENTIALS_KEY_BYTES} bytes, veio ${key.length}`,
    )
  return key
}

/** Lê `CREDENTIALS_KEY` do ambiente (ou de `env`) e valida. */
export function loadCredentialsKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  return parseCredentialsKey(env.CREDENTIALS_KEY)
}

export interface CredentialCipher {
  readonly keyVersion: number
  encrypt<T extends Plaintext>(plaintext: T, opts?: CipherOptions): EncryptedPayload<T extends string ? string : Buffer>
  decrypt<T extends Plaintext>(payload: EncryptedPayload<T>, opts?: CipherOptions): T
}

function toAad(aad: string | Buffer | undefined): Buffer | undefined {
  return aad === undefined ? undefined : Buffer.isBuffer(aad) ? aad : Buffer.from(aad, 'utf8')
}

/**
 * Cria um cifrador. `key` pode ser o Buffer de 32 bytes ou a string base64; sem `key`, lê `CREDENTIALS_KEY`.
 * Valida a chave imediatamente (erro na inicialização).
 */
export function createCipher(key?: Buffer | string, keyVersion: number = DEFAULT_KEY_VERSION): CredentialCipher {
  const k = key === undefined ? loadCredentialsKey() : Buffer.isBuffer(key) ? key : parseCredentialsKey(key)
  if (k.length !== CREDENTIALS_KEY_BYTES)
    throw new CredentialsKeyError(`chave inválida: esperado ${CREDENTIALS_KEY_BYTES} bytes`)
  const secret = Buffer.from(k) // cópia: mutações externas não afetam o cifrador

  return {
    keyVersion,
    encrypt(plaintext, opts = {}) {
      const isString = typeof plaintext === 'string'
      const body = isString ? Buffer.from(plaintext, 'utf8') : plaintext
      if (!isString && !Buffer.isBuffer(body)) throw new TypeError('encrypt aceita string ou Buffer')
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(CREDENTIALS_ALGORITHM, secret, iv, { authTagLength: AUTH_TAG_BYTES })
      const aad = toAad(opts.aad)
      if (aad) cipher.setAAD(aad)
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.of(isString ? KIND_STRING : KIND_BUFFER)),
        cipher.update(body),
        cipher.final(),
      ])
      return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion }
    },
    decrypt<T extends Plaintext>(payload: EncryptedPayload<T>, opts: CipherOptions = {}): T {
      if (payload.keyVersion !== undefined && payload.keyVersion !== keyVersion)
        throw new DecryptionError(
          `versão de chave ${payload.keyVersion} não corresponde à chave carregada (${keyVersion})`,
        )
      if (payload.iv?.length !== IV_BYTES || payload.authTag?.length !== AUTH_TAG_BYTES) throw new DecryptionError()
      let plain: Buffer
      try {
        const decipher = createDecipheriv(CREDENTIALS_ALGORITHM, secret, payload.iv, { authTagLength: AUTH_TAG_BYTES })
        const aad = toAad(opts.aad)
        if (aad) decipher.setAAD(aad)
        decipher.setAuthTag(payload.authTag)
        plain = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()])
      } catch {
        throw new DecryptionError()
      }
      const kind = plain[0]
      const body = plain.subarray(1)
      if (kind === KIND_STRING) return body.toString('utf8') as T
      if (kind === KIND_BUFFER) return Buffer.from(body) as T
      throw new DecryptionError()
    },
  }
}

let defaultCipher: CredentialCipher | undefined

/** Valida `CREDENTIALS_KEY` e prepara o cifrador padrão. Chame no boot da API/worker para falhar cedo. */
export function initCredentialsCrypto(key?: Buffer | string, keyVersion?: number): CredentialCipher {
  defaultCipher = createCipher(key, keyVersion)
  return defaultCipher
}

/** Cifrador padrão (inicializado sob demanda a partir de `CREDENTIALS_KEY`). */
export function getCredentialsCipher(): CredentialCipher {
  return (defaultCipher ??= createCipher())
}

/** Descarta o cifrador padrão (útil em testes que trocam `CREDENTIALS_KEY`). */
export function resetCredentialsCrypto(): void {
  defaultCipher = undefined
}

/** Cifra com o cifrador padrão (`CREDENTIALS_KEY`). */
export function encrypt<T extends Plaintext>(
  plaintext: T,
  opts?: CipherOptions,
): EncryptedPayload<T extends string ? string : Buffer> {
  return getCredentialsCipher().encrypt(plaintext, opts)
}

/** Decifra com o cifrador padrão. Lança `DecryptionError` se ciphertext, IV, auth tag ou AAD forem adulterados. */
export function decrypt<T extends Plaintext>(payload: EncryptedPayload<T>, opts?: CipherOptions): T {
  return getCredentialsCipher().decrypt(payload, opts)
}

/** Gera uma chave nova (base64) para CREDENTIALS_KEY. */
export function generateCredentialsKey(): string {
  return randomBytes(CREDENTIALS_KEY_BYTES).toString('base64')
}
