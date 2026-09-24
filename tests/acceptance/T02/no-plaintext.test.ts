// AC-T02-04: nada de credencial em texto puro na tabela session_credentials (regra inviolável 1.4.1).
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, sessions, type TempDatabase } from '@wsm/db'
import { fakePhone, uniqueId } from '../helpers/factories'
import { loadCoreWithKey, newKey, preserveKeyEnv } from './shared'

type Db = ReturnType<typeof createDb>

let restoreEnv: () => void
let temp: TempDatabase
let db: Db

beforeAll(async () => {
  restoreEnv = preserveKeyEnv()
  temp = await createTempDatabase({ migrate: true, prefix: 'wsm_t02' })
  db = createDb(temp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end().catch(() => {})
  await temp?.drop()
  restoreEnv()
})

/** Todas as representações textuais pelas quais o marcador poderia vazar. */
function encodings(marker: string): string[] {
  const b = Buffer.from(marker, 'utf8')
  return [marker, b.toString('hex'), b.toString('base64').replace(/=+$/, ''), JSON.stringify([...b]).slice(1, -1)]
}

/** Linhas da tabela crua em várias formas: JSON da linha e cada bytea como escape/hex/base64. */
async function rawDump(sessionId: string): Promise<{ count: number; text: string }> {
  const { rows } = await db.$client.query(
    `SELECT row_to_json(sc)::text AS json,
            concat_ws(' ', encode(ciphertext, 'escape'), encode(iv, 'escape'), encode(auth_tag, 'escape')) AS esc,
            concat_ws(' ', encode(ciphertext, 'hex'), encode(iv, 'hex'), encode(auth_tag, 'hex')) AS hex,
            concat_ws(' ', encode(ciphertext, 'base64'), encode(iv, 'base64'), encode(auth_tag, 'base64')) AS b64,
            key_type, key_id
       FROM session_credentials sc WHERE session_id = $1`,
    [sessionId],
  )
  const text = rows.map((r: Record<string, string>) => Object.values(r).join('\n').replace(/\s+/g, '')).join('\n')
  return { count: rows.length, text }
}

function expectNoLeak(text: string, marker: string) {
  for (const enc of encodings(marker)) {
    expect(text.includes(enc.replace(/\s+/g, '')), `marcador encontrado na tabela crua (codificação: ${enc.slice(0, 40)})`).toBe(false)
  }
}

describe('T02 — sem texto puro em session_credentials', () => {
  it('AC-T02-04 marcador salvo nas creds (saveCreds) não aparece em nenhuma coluna', async () => {
    const core = await loadCoreWithKey(newKey())
    const [row] = await db.insert(sessions).values({ name: uniqueId('session'), phone: fakePhone() }).returning({ id: sessions.id })
    const sessionId = row!.id
    const marker = `MARCADOR-CRED-${randomBytes(12).toString('hex')}`

    const { state, saveCreds } = await core.usePostgresAuthState(db, sessionId)
    state.creds.me = { id: `${fakePhone()}:1@s.whatsapp.net`, name: marker }
    state.creds.advSecretKey = marker
    state.creds.lastPropHash = marker
    await saveCreds()

    const dump = await rawDump(sessionId)
    expect(dump.count, 'saveCreds não gravou nada em session_credentials').toBeGreaterThan(0)
    expectNoLeak(dump.text, marker)
  })

  it('AC-T02-04 marcador salvo em keys.set (string e bytes) não aparece em nenhuma coluna', async () => {
    const core = await loadCoreWithKey(newKey())
    const [row] = await db.insert(sessions).values({ name: uniqueId('session'), phone: fakePhone() }).returning({ id: sessions.id })
    const sessionId = row!.id
    const marker = `MARCADOR-KEY-${randomBytes(12).toString('hex')}`

    const { state } = await core.usePostgresAuthState(db, sessionId)
    await state.keys.set({
      session: { 'peer.0': Buffer.from(marker, 'utf8') },
      'pre-key': { '1': { private: Buffer.from(marker, 'utf8'), public: randomBytes(32) } },
      'sender-key-memory': { 'grupo@g.us': { [marker]: true } },
    })

    const dump = await rawDump(sessionId)
    expect(dump.count, 'keys.set não gravou nada em session_credentials').toBeGreaterThanOrEqual(3)
    expectNoLeak(dump.text, marker)
  })

  it('AC-T02-04 linhas gravadas têm ciphertext, iv, auth_tag e key_version preenchidos', async () => {
    const core = await loadCoreWithKey(newKey())
    const [row] = await db.insert(sessions).values({ name: uniqueId('session'), phone: fakePhone() }).returning({ id: sessions.id })
    const { saveCreds } = await core.usePostgresAuthState(db, row!.id)
    await saveCreds()
    const { rows } = await db.$client.query(
      `SELECT length(ciphertext) AS ct, length(iv) AS iv, length(auth_tag) AS tag, key_version FROM session_credentials WHERE session_id = $1`,
      [row!.id],
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.ct).toBeGreaterThan(0)
      expect(r.iv).toBeGreaterThanOrEqual(12)
      expect(r.tag).toBe(16)
      expect(typeof r.key_version).toBe('number')
    }
  })
})
