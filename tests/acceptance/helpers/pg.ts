// Acesso caixa-preta ao Postgres via `psql` (sem depender de driver no workspace de testes).
// Bancos descartáveis por suíte: createTempDb() → migrate() → ... → dropTempDb().
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { exec, type ExecResult } from './exec'

export const DEFAULT_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://wsm:wsm@localhost:5432/wsm'

/** Localiza o psql: WSM_PSQL, binários nativos de spec/INFRA.md, ou PATH. */
function psqlBin(): string {
  if (process.env.WSM_PSQL) return process.env.WSM_PSQL
  const tools = process.env.WSM_TOOLS ?? 'C:/Users/green/tools'
  for (const p of [`${tools}/pg/pgsql/bin/psql.exe`, `${tools}/pg/pgsql/bin/psql`]) if (existsSync(p)) return p
  return 'psql'
}

export const dbUrl = (name: string, base = DEFAULT_DATABASE_URL) => {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

export interface SqlResult {
  code: number
  stdout: string
  stderr: string
  /** linhas do resultado (formato -At, colunas separadas por \x1f) */
  rows: string[][]
}

/** Executa SQL (via stdin) e nunca lança. ON_ERROR_STOP=1: erro → code != 0. */
export function sql(url: string, query: string): SqlResult {
  const res = spawnSync(psqlBin(), ['-X', '-q', '-A', '-t', '-F', '\x1f', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', '-'], {
    input: `\\set VERBOSITY verbose\n${query}`,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PGCONNECT_TIMEOUT: '10' },
  })
  const stdout = (res.stdout ?? '').replace(/\r/g, '')
  const stderr = `${res.stderr ?? ''}${res.error ? `\n[psql error] ${res.error.message}` : ''}`
  const rows = stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\x1f'))
  return { code: res.status ?? 1, stdout, stderr, rows }
}

/** Como sql(), mas falha com mensagem legível se der erro. */
export function sqlOk(url: string, query: string): string[][] {
  const r = sql(url, query)
  if (r.code !== 0) throw new Error(`SQL falhou (exit ${r.code}): ${r.stderr.trim()}\n--- query ---\n${query}`)
  return r.rows
}

export const lit = (v: string) => `'${v.replace(/'/g, "''")}'`
export const ident = (v: string) => `"${v.replace(/"/g, '""')}"`

export interface TempDb {
  name: string
  url: string
}

export function createTempDb(prefix = 'wsm_test'): TempDb {
  const name = `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
  sqlOk(DEFAULT_DATABASE_URL, `CREATE DATABASE ${ident(name)};`)
  return { name, url: dbUrl(name) }
}

export function dropTempDb(db: TempDb | undefined) {
  if (!db) return
  sql(DEFAULT_DATABASE_URL, `DROP DATABASE IF EXISTS ${ident(db.name)} WITH (FORCE);`)
}

/** Contrato do T01: `pnpm --filter @wsm/db migrate` com DATABASE_URL apontando para o banco. */
export function migrate(db: TempDb): ExecResult {
  return exec('pnpm --filter @wsm/db migrate', { env: { DATABASE_URL: db.url }, timeoutMs: 300_000 })
}

export function tableNames(url: string, schema = 'public'): string[] {
  return sqlOk(url, `SELECT table_name FROM information_schema.tables WHERE table_schema = ${lit(schema)} AND table_type = 'BASE TABLE' ORDER BY 1;`).map((r) => r[0]!)
}

export interface ColumnInfo {
  name: string
  dataType: string
  udtName: string
  nullable: boolean
  default: string | null
}

export function columns(url: string, table: string): ColumnInfo[] {
  return sqlOk(
    url,
    `SELECT column_name, data_type, udt_name, is_nullable, coalesce(column_default, '<<null>>')
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${lit(table)} ORDER BY ordinal_position;`,
  ).map(([name, dataType, udtName, nullable, def]) => ({
    name: name!,
    dataType: dataType!,
    udtName: udtName!,
    nullable: nullable === 'YES',
    default: def === '<<null>>' ? null : def!,
  }))
}

/** SQLSTATE de uma falha (ex.: 23505 unique_violation), extraído da saída verbose do psql. */
export function sqlState(r: SqlResult): string | undefined {
  return /ERROR:\s+([0-9A-Z]{5}):/.exec(r.stderr)?.[1]
}

/** Valores válidos pelos contratos da SPEC (3.2, 3.3, T01) para colunas com constraint conhecida. */
const CONTRACT_DEFAULTS: Record<string, Record<string, () => string>> = {
  sessions: { status: () => 'NEW' },
  messages: { status: () => 'queued' },
  contacts: { phone: () => `+55999${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` },
}

/**
 * Insere uma linha em `table` preenchendo automaticamente colunas NOT NULL sem default
 * (e criando linhas-pai para FKs), para testar constraints sem conhecer o schema interno.
 * Retorna o valor da(s) PK(s) inserida(s) como objeto coluna→texto.
 */
export function insertRow(url: string, table: string, overrides: Record<string, string | null> = {}, depth = 0): Record<string, string> {
  if (depth > 5) throw new Error(`FKs aninhadas demais ao inserir em ${table}`)
  const cols = columns(url, table)
  if (cols.length === 0) throw new Error(`tabela ${table} não existe`)
  const fks = sqlOk(
    url,
    `SELECT a.attname, cf.relname, af.attname
       FROM pg_constraint c
       JOIN pg_class ct ON ct.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = ct.relnamespace
       JOIN pg_class cf ON cf.oid = c.confrelid
       JOIN LATERAL unnest(c.conkey, c.confkey) AS k(src, dst) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.src
       JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = k.dst
      WHERE c.contype = 'f' AND n.nspname = 'public' AND ct.relname = ${lit(table)};`,
  )
  const fkMap = new Map(fks.map(([col, refTable, refCol]) => [col!, { refTable: refTable!, refCol: refCol! }]))

  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(overrides)) values[k] = v === null ? 'NULL' : lit(v)
  for (const c of cols) {
    if (c.name in values) continue
    if (c.nullable || c.default !== null) continue
    const contract = CONTRACT_DEFAULTS[table]?.[c.name]
    if (contract) {
      values[c.name] = c.dataType === 'USER-DEFINED' ? `${lit(contract())}::${ident(c.udtName)}` : lit(contract())
      continue
    }
    const fk = fkMap.get(c.name)
    if (fk) {
      const parent = insertRow(url, fk.refTable, {}, depth + 1)
      const refVal = parent[fk.refCol] ?? sqlOk(url, `SELECT ${ident(fk.refCol)} FROM ${ident(fk.refTable)} ORDER BY ctid DESC LIMIT 1;`)[0]![0]!
      values[c.name] = lit(refVal)
      continue
    }
    values[c.name] = placeholder(url, c)
  }
  const names = Object.keys(values)
  const q = names.length
    ? `INSERT INTO ${ident(table)} (${names.map(ident).join(', ')}) VALUES (${names.map((n) => values[n]).join(', ')}) RETURNING row_to_json(${ident(table)}.*);`
    : `INSERT INTO ${ident(table)} DEFAULT VALUES RETURNING row_to_json(${ident(table)}.*);`
  const row = sqlOk(url, q)[0]![0]!
  const obj = JSON.parse(row) as Record<string, unknown>
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)]))
}

/** Tenta inserir e devolve o resultado cru (sem lançar), para testar violações. */
export function tryInsert(url: string, table: string, values: Record<string, string | null>): SqlResult {
  const names = Object.keys(values)
  return sql(url, `INSERT INTO ${ident(table)} (${names.map(ident).join(', ')}) VALUES (${names.map((n) => (values[n] === null ? 'NULL' : lit(values[n]!))).join(', ')});`)
}

/** Valores para colunas obrigatórias, com base no tipo. */
function placeholder(url: string, c: ColumnInfo): string {
  const rnd = randomBytes(6).toString('hex')
  switch (c.dataType) {
    case 'uuid':
      return 'gen_random_uuid()'
    case 'text':
    case 'character varying':
    case 'character':
      return lit(`t_${rnd}`)
    case 'integer':
    case 'bigint':
    case 'smallint':
    case 'numeric':
    case 'real':
    case 'double precision':
      return '1'
    case 'boolean':
      return 'false'
    case 'timestamp with time zone':
    case 'timestamp without time zone':
    case 'date':
      return 'now()'
    case 'json':
    case 'jsonb':
      return `'{}'`
    case 'bytea':
      return `'\\x00'::bytea`
    case 'inet':
      return `'127.0.0.1'`
    case 'ARRAY':
      return `'{}'`
    case 'USER-DEFINED': {
      const label = enumLabels(url, c.udtName)[0]
      if (!label) throw new Error(`tipo ${c.udtName} de ${c.name} não suportado`)
      return `${lit(label)}::${ident(c.udtName)}`
    }
    default:
      throw new Error(`tipo ${c.dataType} de ${c.name} não suportado pelo insertRow`)
  }
}

export function enumLabels(url: string, typeName: string): string[] {
  return sqlOk(url, `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = ${lit(typeName)} ORDER BY e.enumsortorder;`).map((r) => r[0]!)
}
