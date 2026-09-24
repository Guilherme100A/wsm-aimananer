// usePostgresAuthState contra um Postgres descartável. Sem Baileys nos testes (AC-T04-04):
// as creds iniciais vêm do próprio auth state (initAuthCreds do produto) e os fixtures de keys são montados aqui.
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, sessions, type TempDatabase } from '@wsm/db'
import { fakePhone, uniqueId } from '../helpers/factories'
import { loadCoreWithKey, newKey, normalize, preserveKeyEnv } from './shared'

type Db = ReturnType<typeof createDb>
type AuthState = { state: { creds: any; keys: { get: (type: string, ids: string[]) => Promise<Record<string, any>>; set: (data: Record<string, Record<string, any>>) => Promise<void> } }; saveCreds: () => Promise<void> }

const KEY = newKey()
let restoreEnv: () => void
let temp: TempDatabase
const pools: Db[] = []

beforeAll(async () => {
  restoreEnv = preserveKeyEnv()
  temp = await createTempDatabase({ migrate: true, prefix: 'wsm_t02' })
}, 120_000)

afterEach(async () => {
  for (const db of pools.splice(0)) await db.$client.end().catch(() => {})
})

afterAll(async () => {
  await temp?.drop()
  restoreEnv()
})

function newDb(): Db {
  const db = createDb(temp.url, { max: 4 })
  pools.push(db)
  return db
}

async function newSession(db: Db): Promise<string> {
  const [row] = await db.insert(sessions).values({ name: uniqueId('session'), phone: fakePhone() }).returning({ id: sessions.id })
  return row!.id
}

/** Carrega o auth state como num processo novo: módulo recarregado e pool novo. */
async function openAuthState(sessionId: string, db: Db = newDb()): Promise<AuthState> {
  const core = await loadCoreWithKey(KEY)
  expect(typeof core.usePostgresAuthState, '@wsm/core não exporta usePostgresAuthState').toBe('function')
  return (await core.usePostgresAuthState(db, sessionId)) as AuthState
}

const bytes = (n: number) => randomBytes(n)
const keyPair = () => ({ private: bytes(32), public: bytes(32) })

describe('T02 — usePostgresAuthState', () => {
  it('AC-T02-03 expõe state.creds, state.keys.get, state.keys.set e saveCreds', async () => {
    const db = newDb()
    const auth = await openAuthState(await newSession(db), db)
    expect(auth.state.creds).toBeTruthy()
    expect(typeof auth.state.keys.get).toBe('function')
    expect(typeof auth.state.keys.set).toBe('function')
    expect(typeof auth.saveCreds).toBe('function')
  })

  it('AC-T02-03 sessão sem nada salvo recebe creds novas no formato do Baileys (initAuthCreds)', async () => {
    const db = newDb()
    const { state } = await openAuthState(await newSession(db), db)
    const c = state.creds
    for (const k of ['noiseKey', 'pairingEphemeralKeyPair', 'signedIdentityKey']) {
      expect(c[k]?.private, `${k}.private`).toBeInstanceOf(Uint8Array)
      expect(c[k]?.public, `${k}.public`).toBeInstanceOf(Uint8Array)
    }
    expect(c.signedPreKey?.keyPair?.private).toBeInstanceOf(Uint8Array)
    expect(typeof c.registrationId).toBe('number')
    expect(typeof c.advSecretKey).toBe('string')
  })

  it('AC-T02-03 saveCreds + restart recarrega creds idênticas (incluindo alterações)', async () => {
    const db = newDb()
    const sessionId = await newSession(db)
    const first = await openAuthState(sessionId, db)
    first.state.creds.me = { id: `${fakePhone()}:7@s.whatsapp.net`, name: 'Sessão de teste' }
    first.state.creds.registered = true
    first.state.creds.pairingCode = 'ABCD1234'
    first.state.creds.processedHistoryMessages = [{ key: { id: 'H1', remoteJid: 'x@s.whatsapp.net' }, messageTimestamp: 1700000000 }]
    first.state.creds.lastPropHash = 'hash-1'
    await first.saveCreds()
    const expected = normalize(first.state.creds)

    const reloaded = await openAuthState(sessionId)
    expect(normalize(reloaded.state.creds)).toEqual(expected)
    // bytes continuam bytes após o restart (BufferJSON), não viram { type: 'Buffer' } nem string
    expect(reloaded.state.creds.noiseKey.private).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(reloaded.state.creds.noiseKey.private).equals(Buffer.from(first.state.creds.noiseKey.private))).toBe(true)
  })

  it('AC-T02-03 creds sem saveCreds não são persistidas; saveCreds repetido grava a última versão', async () => {
    const db = newDb()
    const sessionId = await newSession(db)
    const a = await openAuthState(sessionId, db)
    a.state.creds.lastPropHash = 'v1'
    await a.saveCreds()
    a.state.creds.lastPropHash = 'v2'
    await a.saveCreds()
    a.state.creds.lastPropHash = 'v3-nao-salvo'

    const b = await openAuthState(sessionId)
    expect(b.state.creds.lastPropHash).toBe('v2')
  })

  it('AC-T02-03 keys.set/keys.get fazem ida e volta por tipo e sobrevivem ao restart', async () => {
    const db = newDb()
    const sessionId = await newSession(db)
    const auth = await openAuthState(sessionId, db)

    const preKeys = { '1': keyPair(), '2': keyPair() }
    const sessionData = { [`${fakePhone()}.0`]: bytes(200) }
    const senderKey = { [`grupo-${uniqueId('g')}@g.us::${fakePhone()}::0`]: bytes(64) }
    const memory = { [`${uniqueId('g')}@g.us`]: { [`${fakePhone()}@s.whatsapp.net`]: true } }
    const appStateKeyData = bytes(32)
    const appStateSync = { AAAAAKs1: { keyData: appStateKeyData, fingerprint: { rawId: 42, currentIndex: 1, deviceIndexes: [0, 1] }, timestamp: 1700000000000 } }

    await auth.state.keys.set({
      'pre-key': preKeys,
      session: sessionData,
      'sender-key': senderKey,
      'sender-key-memory': memory,
      'app-state-sync-key': appStateSync,
    })

    for (const s of [auth, await openAuthState(sessionId)]) {
      const pk = await s.state.keys.get('pre-key', ['1', '2', '999'])
      expect(normalize(pk['1'])).toEqual(normalize(preKeys['1']))
      expect(normalize(pk['2'])).toEqual(normalize(preKeys['2']))
      expect(pk['999'] ?? null, 'id inexistente deve voltar vazio').toBeNull()

      const sid = Object.keys(sessionData)[0]!
      const ss = await s.state.keys.get('session', [sid])
      expect(ss[sid]).toBeInstanceOf(Uint8Array)
      expect(Buffer.from(ss[sid]).equals(sessionData[sid]!)).toBe(true)

      const skid = Object.keys(senderKey)[0]!
      const sk = await s.state.keys.get('sender-key', [skid])
      expect(Buffer.from(sk[skid]).equals(senderKey[skid]!)).toBe(true)

      const mid = Object.keys(memory)[0]!
      const mem = await s.state.keys.get('sender-key-memory', [mid])
      expect(mem[mid]).toEqual(memory[mid])

      const as = await s.state.keys.get('app-state-sync-key', ['AAAAAKs1'])
      const v = as.AAAAAKs1
      expect(v, 'app-state-sync-key não recarregada').toBeTruthy()
      expect(Buffer.from(v.keyData).equals(appStateKeyData)).toBe(true)
      expect(Number(v.fingerprint?.rawId)).toBe(42)
      expect(Number(v.timestamp)).toBe(1700000000000)
    }
  })

  it('AC-T02-03 keys.set com null remove a chave (também após restart)', async () => {
    const db = newDb()
    const sessionId = await newSession(db)
    const auth = await openAuthState(sessionId, db)
    await auth.state.keys.set({ 'pre-key': { '10': keyPair(), '11': keyPair() } })
    await auth.state.keys.set({ 'pre-key': { '10': null } })

    const now = await auth.state.keys.get('pre-key', ['10', '11'])
    expect(now['10'] ?? null).toBeNull()
    expect(now['11']).toBeTruthy()

    const after = await (await openAuthState(sessionId)).state.keys.get('pre-key', ['10', '11'])
    expect(after['10'] ?? null).toBeNull()
    expect(after['11']).toBeTruthy()
  })

  it('AC-T02-03 keys.set sobrescreve valor existente', async () => {
    const db = newDb()
    const sessionId = await newSession(db)
    const auth = await openAuthState(sessionId, db)
    const v1 = bytes(40)
    const v2 = bytes(40)
    await auth.state.keys.set({ session: { 'peer.0': v1 } })
    await auth.state.keys.set({ session: { 'peer.0': v2 } })
    const got = await (await openAuthState(sessionId)).state.keys.get('session', ['peer.0'])
    expect(Buffer.from(got['peer.0']).equals(v2)).toBe(true)
  })

  it('AC-T02-03 estados de sessões diferentes são isolados', async () => {
    const db = newDb()
    const s1 = await newSession(db)
    const s2 = await newSession(db)
    const a = await openAuthState(s1, db)
    const b = await openAuthState(s2, db)
    await a.state.keys.set({ 'pre-key': { '5': keyPair() } })
    a.state.creds.lastPropHash = 'somente-s1'
    await a.saveCreds()
    await b.saveCreds()

    expect((await b.state.keys.get('pre-key', ['5']))['5'] ?? null).toBeNull()
    const b2 = await openAuthState(s2)
    expect(b2.state.creds.lastPropHash).not.toBe('somente-s1')
    expect(normalize(b2.state.creds.noiseKey)).not.toEqual(normalize(a.state.creds.noiseKey))
  })
})
