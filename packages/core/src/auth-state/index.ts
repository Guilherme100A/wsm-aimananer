// Auth state do Baileys persistido cifrado no Postgres (SPEC T02). Substitui o auth state em arquivos do Baileys:
// cada creds/key vira uma linha em session_credentials com JSON (BufferJSON) cifrado em AES-256-GCM.
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys'
import { sessionCredentials, type Database } from '@wsm/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getCredentialsCipher, type CredentialCipher } from '../crypto'

export const CREDS_KEY_TYPE = 'creds'
export const CREDS_KEY_ID = 'creds'

export interface PostgresAuthState {
  state: AuthenticationState
  saveCreds: () => Promise<void>
  /** Remove todas as credenciais da sessão (ex.: após logout). */
  clear: () => Promise<void>
}

export interface PostgresAuthStateOptions {
  /** Cifrador; default: o padrão de `CREDENTIALS_KEY`. */
  cipher?: CredentialCipher
}

/** AAD que amarra cada ciphertext à sua linha (impede trocar valores entre sessões/chaves). */
export const credentialAad = (sessionId: string, keyType: string, keyId: string) => `${sessionId}/${keyType}/${keyId}`

type Row = typeof sessionCredentials.$inferSelect

export async function usePostgresAuthState(
  db: Database,
  sessionId: string,
  opts: PostgresAuthStateOptions = {},
): Promise<PostgresAuthState> {
  const cipher = opts.cipher ?? getCredentialsCipher()

  const seal = (keyType: string, keyId: string, value: unknown) => {
    const json = JSON.stringify(value, BufferJSON.replacer)
    const enc = cipher.encrypt(json, { aad: credentialAad(sessionId, keyType, keyId) })
    return {
      sessionId,
      keyType,
      keyId,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
    }
  }

  const open = (row: Row): unknown => {
    const json = cipher.decrypt<string>(
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag, keyVersion: row.keyVersion },
      { aad: credentialAad(sessionId, row.keyType, row.keyId) },
    )
    return JSON.parse(json, BufferJSON.reviver)
  }

  const upsert = async (rows: ReturnType<typeof seal>[], exec: Pick<Database, 'insert'> = db) => {
    if (rows.length === 0) return
    await exec
      .insert(sessionCredentials)
      .values(rows)
      .onConflictDoUpdate({
        target: [sessionCredentials.sessionId, sessionCredentials.keyType, sessionCredentials.keyId],
        set: {
          ciphertext: sql`excluded.ciphertext`,
          iv: sql`excluded.iv`,
          authTag: sql`excluded.auth_tag`,
          keyVersion: sql`excluded.key_version`,
          updatedAt: sql`now()`,
        },
      })
  }

  const [credsRow] = await db
    .select()
    .from(sessionCredentials)
    .where(
      and(
        eq(sessionCredentials.sessionId, sessionId),
        eq(sessionCredentials.keyType, CREDS_KEY_TYPE),
        eq(sessionCredentials.keyId, CREDS_KEY_ID),
      ),
    )
    .limit(1)
  const creds: AuthenticationCreds = credsRow ? (open(credsRow) as AuthenticationCreds) : initAuthCreds()

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const data: { [id: string]: SignalDataTypeMap[T] } = {}
        if (ids.length === 0) return data
        const rows = await db
          .select()
          .from(sessionCredentials)
          .where(
            and(
              eq(sessionCredentials.sessionId, sessionId),
              eq(sessionCredentials.keyType, type),
              inArray(sessionCredentials.keyId, ids),
            ),
          )
        for (const row of rows) {
          let value = open(row)
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>)
          }
          data[row.keyId] = value as SignalDataTypeMap[T]
        }
        return data
      },
      set: async (data: SignalDataSet) => {
        const toUpsert: ReturnType<typeof seal>[] = []
        const toDelete = new Map<string, string[]>()
        for (const category in data) {
          const entries = data[category as keyof SignalDataTypeMap] ?? {}
          for (const id in entries) {
            const value = entries[id]
            if (value) toUpsert.push(seal(category, id, value))
            else toDelete.set(category, [...(toDelete.get(category) ?? []), id])
          }
        }
        if (toUpsert.length === 0 && toDelete.size === 0) return
        await db.transaction(async (tx) => {
          await upsert(toUpsert, tx)
          for (const [keyType, ids] of toDelete) {
            await tx
              .delete(sessionCredentials)
              .where(
                and(
                  eq(sessionCredentials.sessionId, sessionId),
                  eq(sessionCredentials.keyType, keyType),
                  inArray(sessionCredentials.keyId, ids),
                ),
              )
          }
        })
      },
    },
  }

  return {
    state,
    saveCreds: () => upsert([seal(CREDS_KEY_TYPE, CREDS_KEY_ID, creds)]),
    clear: async () => {
      await db.delete(sessionCredentials).where(eq(sessionCredentials.sessionId, sessionId))
    },
  }
}
