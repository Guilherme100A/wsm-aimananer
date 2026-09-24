import { describe, expect, it } from 'vitest'
import { columns, insertRow, sql, sqlOk, sqlState } from '../helpers/pg'
import { useMigratedDb } from './shared'

const KEY_COLUMNS = ['session_id', 'key_type', 'key_id']
const ALLOWED = [...KEY_COLUMNS, 'ciphertext', 'iv', 'auth_tag', 'key_version', 'updated_at']

describe('T01 — session_credentials', () => {
  const ctx = useMigratedDb()

  it('AC-T01-03 session_credentials só tem ciphertext, iv, auth_tag, key_version, updated_at e a chave (session_id, key_type, key_id)', () => {
    const names = columns(ctx.db.url, 'session_credentials').map((c) => c.name)
    expect([...names].sort()).toEqual([...ALLOWED].sort())
  })

  it('AC-T01-03 (session_id, key_type, key_id) é a chave de session_credentials: repetir a tripla falha no banco', () => {
    const keys = sqlOk(
      ctx.db.url,
      `SELECT string_agg(a.attname, ',' ORDER BY a.attname)
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'public.session_credentials'::regclass AND c.contype IN ('p', 'u')
        GROUP BY c.oid;`,
    ).map((r) => r[0])
    expect(keys, `PK/UNIQUE encontradas: ${JSON.stringify(keys)}`).toContain([...KEY_COLUMNS].sort().join(','))

    const session = insertRow(ctx.db.url, 'sessions')
    const row = insertRow(ctx.db.url, 'session_credentials', { session_id: session.id!, key_type: 'creds', key_id: 'main' })
    expect(row.session_id).toBe(session.id)

    const cols = ALLOWED.map((c) => `"${c}"`).join(', ')
    const dup = sql(ctx.db.url, `INSERT INTO session_credentials (${cols}) SELECT ${cols} FROM session_credentials WHERE session_id = '${session.id}';`)
    expect(dup.code, 'tripla duplicada deveria falhar').not.toBe(0)
    expect(sqlState(dup), dup.stderr).toBe('23505')
  })
})
