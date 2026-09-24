// Usa um Postgres descartável (spec/INFRA.md): DATABASE_URL ou postgres://wsm:wsm@localhost:5432/wsm.
import { randomBytes } from 'node:crypto'
import { createDb, createTempDatabase, sessionCredentials, sessions, type Database, type TempDatabase } from '@wsm/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCipher, generateCredentialsKey, DecryptionError } from '../crypto'
import { usePostgresAuthState } from './index'

const cipher = createCipher(generateCredentialsKey())
let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_auth' })
  db = createDb(temp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

async function newSession(): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({ name: `s-${randomBytes(4).toString('hex')}`, phone: `55119${Date.now() % 1e8}` })
    .returning({ id: sessions.id })
  return row!.id
}

describe('usePostgresAuthState', () => {
  it('gera creds iniciais e as recarrega idênticas após restart', async () => {
    const id = await newSession()
    const a = await usePostgresAuthState(db, id, { cipher })
    expect(Buffer.isBuffer(a.state.creds.noiseKey.private)).toBe(true)
    a.state.creds.me = { id: '5511999999999@s.whatsapp.net', name: 'Teste' }
    await a.saveCreds()

    const b = await usePostgresAuthState(db, id, { cipher })
    expect(b.state.creds.me).toEqual(a.state.creds.me)
    expect(Buffer.from(b.state.creds.noiseKey.private).equals(a.state.creds.noiseKey.private)).toBe(true)
    expect(Buffer.from(b.state.creds.signedIdentityKey.public).equals(a.state.creds.signedIdentityKey.public)).toBe(
      true,
    )
    expect(b.state.creds.registrationId).toBe(a.state.creds.registrationId)
  })

  it('keys.set/get com Buffers, app-state-sync-key como proto e null remove', async () => {
    const id = await newSession()
    const { state } = await usePostgresAuthState(db, id, { cipher })
    const pre = { private: randomBytes(32), public: randomBytes(32) }
    await state.keys.set({
      'pre-key': { '1': pre, '2': pre },
      'app-state-sync-key': { K1: { keyData: randomBytes(32), timestamp: 123 } as never },
    })

    const reloaded = (await usePostgresAuthState(db, id, { cipher })).state
    const got = await reloaded.keys.get('pre-key', ['1', '2', '3'])
    expect(Buffer.from(got['1']!.private).equals(pre.private)).toBe(true)
    expect(got['3']).toBeUndefined()
    const sync = await reloaded.keys.get('app-state-sync-key', ['K1'])
    expect(sync.K1?.constructor.name).toBe('AppStateSyncKeyData')

    await reloaded.keys.set({ 'pre-key': { '1': null } })
    expect(Object.keys(await reloaded.keys.get('pre-key', ['1', '2']))).toEqual(['2'])
    expect(await reloaded.keys.get('pre-key', [])).toEqual({})
  })

  it('nada em texto puro nas colunas; ciphertext trocado entre linhas é rejeitado (AAD)', async () => {
    const id = await newSession()
    const marker = `MARCADOR-${randomBytes(8).toString('hex')}`
    const { state, saveCreds } = await usePostgresAuthState(db, id, { cipher })
    state.creds.me = { id: marker }
    await saveCreds()
    await state.keys.set({ session: { peer: Buffer.from(marker) } })

    const { rows } = await db.$client.query('select * from session_credentials where session_id = $1', [id])
    expect(rows.length).toBe(2)
    for (const row of rows) {
      for (const v of Object.values(row)) {
        const text = Buffer.isBuffer(v) ? v.toString('latin1') : String(v)
        expect(text).not.toContain(marker)
        if (Buffer.isBuffer(v)) expect(v.toString('base64')).not.toContain(Buffer.from(marker).toString('base64'))
      }
    }

    // Copia o ciphertext das creds para a linha da key: o AAD difere, então o decrypt falha.
    const creds = rows.find((r) => r.key_type === 'creds')!
    await db.$client.query(
      `update session_credentials set ciphertext = $1, iv = $2, auth_tag = $3 where session_id = $4 and key_type = 'session'`,
      [creds.ciphertext, creds.iv, creds.auth_tag, id],
    )
    await expect(state.keys.get('session', ['peer'])).rejects.toBeInstanceOf(DecryptionError)
  })

  it('clear remove todas as credenciais da sessão', async () => {
    const id = await newSession()
    const auth = await usePostgresAuthState(db, id, { cipher })
    await auth.saveCreds()
    await auth.clear()
    expect(await db.select().from(sessionCredentials)).not.toContainEqual(expect.objectContaining({ sessionId: id }))
  })
})
