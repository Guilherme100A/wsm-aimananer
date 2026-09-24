import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CredentialsKeyError,
  DecryptionError,
  createCipher,
  decrypt,
  encrypt,
  generateCredentialsKey,
  initCredentialsCrypto,
  parseCredentialsKey,
  resetCredentialsCrypto,
} from './index'

const key = generateCredentialsKey()
const flip = (b: Buffer, i = Math.floor(b.length / 2)) => {
  const c = Buffer.from(b)
  c[i]! ^= 0x01
  return c
}

describe('parseCredentialsKey', () => {
  it('aceita 32 bytes em base64', () => expect(parseCredentialsKey(key)).toHaveLength(32))
  it.each([
    ['ausente', undefined],
    ['vazia', '  '],
    ['não-base64', '!!!not-base64!!!'],
    ['16 bytes', randomBytes(16).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
  ])('rejeita chave %s', (_label, raw) => expect(() => parseCredentialsKey(raw)).toThrow(CredentialsKeyError))
})

describe('createCipher', () => {
  const c = createCipher(key)

  it('round-trip de string (inclusive vazia e unicode) devolve string', () => {
    for (const s of ['', 'olá 🌎', 'x'.repeat(10_000)]) expect(c.decrypt(c.encrypt(s))).toBe(s)
  })

  it('round-trip de Buffer devolve Buffer idêntico', () => {
    const b = randomBytes(64)
    const out = c.decrypt(c.encrypt(b))
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(out.equals(b)).toBe(true)
    expect(c.decrypt(c.encrypt(Buffer.alloc(0)))).toHaveLength(0)
  })

  it('IV aleatório por chamada e texto puro ausente do envelope', () => {
    const a = c.encrypt('MARCADOR-SECRETO')
    const b = c.encrypt('MARCADOR-SECRETO')
    expect(a.iv.equals(b.iv)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
    expect(a.ciphertext.includes('MARCADOR-SECRETO')).toBe(false)
    expect(a).toMatchObject({ keyVersion: 1 })
    expect(a.iv).toHaveLength(12)
    expect(a.authTag).toHaveLength(16)
  })

  it.each(['ciphertext', 'iv', 'authTag'] as const)('%s adulterado lança DecryptionError', (part) => {
    const e = c.encrypt('segredo')
    expect(() => c.decrypt({ ...e, [part]: flip(e[part]) })).toThrow(DecryptionError)
  })

  it('auth tag truncado, AAD divergente, chave errada ou keyVersion errada lançam erro', () => {
    const e = c.encrypt('segredo', { aad: 's1/creds/creds' })
    expect(c.decrypt(e, { aad: 's1/creds/creds' })).toBe('segredo')
    expect(() => c.decrypt({ ...e, authTag: e.authTag.subarray(0, 8) }, { aad: 's1/creds/creds' })).toThrow(
      DecryptionError,
    )
    expect(() => c.decrypt(e, { aad: 's2/creds/creds' })).toThrow(DecryptionError)
    expect(() => c.decrypt(e)).toThrow(DecryptionError)
    expect(() => createCipher(generateCredentialsKey()).decrypt(e, { aad: 's1/creds/creds' })).toThrow(DecryptionError)
    expect(() => c.decrypt({ ...e, keyVersion: 2 }, { aad: 's1/creds/creds' })).toThrow(DecryptionError)
  })

  it('chave inválida falha na criação', () => {
    expect(() => createCipher('curta')).toThrow(CredentialsKeyError)
    expect(() => createCipher(randomBytes(31))).toThrow(CredentialsKeyError)
  })
})

describe('encrypt/decrypt padrão (CREDENTIALS_KEY)', () => {
  const original = process.env.CREDENTIALS_KEY
  afterEach(() => {
    if (original === undefined) delete process.env.CREDENTIALS_KEY
    else process.env.CREDENTIALS_KEY = original
    resetCredentialsCrypto()
  })

  it('usa a chave do ambiente', () => {
    process.env.CREDENTIALS_KEY = key
    resetCredentialsCrypto()
    const e = encrypt('abc')
    expect(createCipher(key).decrypt(e)).toBe('abc')
    expect(decrypt(e)).toBe('abc')
  })

  it('sem CREDENTIALS_KEY o primeiro encrypt lança e initCredentialsCrypto falha', () => {
    delete process.env.CREDENTIALS_KEY
    resetCredentialsCrypto()
    expect(() => encrypt('x')).toThrow(CredentialsKeyError)
    expect(() => initCredentialsCrypto()).toThrow(CredentialsKeyError)
  })
})
