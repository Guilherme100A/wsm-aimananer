// Importação de contatos via CSV (AC-T07-02): só entram linhas com consentimento completo.
import { isE164 } from './policy'

/** Parser CSV (RFC 4180): aspas, aspas escapadas, quebras de linha dentro de aspas, CRLF. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const delim = delimiter ?? detectDelimiter(src)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** `;` quando o cabeçalho usa `;` e não `,` (planilhas pt-BR); senão `,`. */
function detectDelimiter(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? ''
  return header.includes(';') && !header.includes(',') ? ';' : ','
}

export type ImportRejectReason =
  | 'invalid_phone'
  | 'consent_not_true'
  | 'missing_consent_at'
  | 'invalid_consent_at'
  | 'missing_consent_source'
  | 'invalid_last_contact_at'
  | 'duplicate_in_file'
  | 'phone_already_exists'

export interface ImportContactRow {
  name: string | null
  phone: string
  consent: true
  consentAt: Date
  consentSource: string
  lastContactAt: Date | null
  optOut: boolean
}

export interface ImportRejected {
  /** Linha no arquivo (1 = cabeçalho, dados a partir de 2). */
  line: number
  phone: string | null
  reason: ImportRejectReason
  message: string
}

export interface ParsedImport {
  accepted: (ImportContactRow & { line: number })[]
  rejected: ImportRejected[]
}

export class CsvHeaderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvHeaderError'
  }
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'sim', 's'])

const HEADER_ALIASES: Record<string, string> = {
  optout: 'opt_out',
  consentat: 'consent_at',
  consentsource: 'consent_source',
  lastcontactat: 'last_contact_at',
}

function normalizeHeader(h: string): string {
  const k = h.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return HEADER_ALIASES[k.replace(/_/g, '')] ?? k
}

function parseDate(raw: string): Date | null {
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

const MESSAGES: Record<ImportRejectReason, string> = {
  invalid_phone: 'phone must be E.164 (e.g. +5511999999999)',
  consent_not_true: 'consent must be true',
  missing_consent_at: 'consent_at is required',
  invalid_consent_at: 'consent_at is not a valid date',
  missing_consent_source: 'consent_source is required',
  invalid_last_contact_at: 'last_contact_at is not a valid date',
  duplicate_in_file: 'phone appears more than once in the file',
  phone_already_exists: 'a contact with this phone already exists',
}

export function rejectMessage(reason: ImportRejectReason): string {
  return MESSAGES[reason]
}

/**
 * Valida as linhas do CSV. Colunas: `phone` (obrigatória no cabeçalho), `name`, `consent`, `consent_at`,
 * `consent_source`, `last_contact_at`. Uma linha só é aceita com `consent=true`, `consent_at` e `consent_source`.
 */
export function parseContactsCsv(text: string): ParsedImport {
  const rows = parseCsv(text)
  const [header, ...data] = rows
  if (!header) throw new CsvHeaderError('CSV is empty')
  const cols = header.map(normalizeHeader)
  if (!cols.includes('phone')) throw new CsvHeaderError('CSV header must include a "phone" column')

  const accepted: ParsedImport['accepted'] = []
  const rejected: ImportRejected[] = []
  const seen = new Set<string>()

  data.forEach((cells, idx) => {
    const line = idx + 2
    if (cells.every((c) => c.trim() === '')) return
    const get = (col: string) => {
      const i = cols.indexOf(col)
      return i >= 0 ? (cells[i] ?? '').trim() : ''
    }
    const phone = get('phone').replace(/[\s().-]/g, '')
    const reject = (reason: ImportRejectReason) =>
      rejected.push({ line, phone: phone || null, reason, message: rejectMessage(reason) })

    if (!isE164(phone)) return reject('invalid_phone')
    if (!TRUE_VALUES.has(get('consent').toLowerCase())) return reject('consent_not_true')
    const consentAtRaw = get('consent_at')
    if (!consentAtRaw) return reject('missing_consent_at')
    const consentAt = parseDate(consentAtRaw)
    if (!consentAt) return reject('invalid_consent_at')
    const consentSource = get('consent_source')
    if (!consentSource) return reject('missing_consent_source')
    const lastRaw = get('last_contact_at')
    const lastContactAt = lastRaw ? parseDate(lastRaw) : null
    if (lastRaw && !lastContactAt) return reject('invalid_last_contact_at')
    if (seen.has(phone)) return reject('duplicate_in_file')
    seen.add(phone)

    accepted.push({ line, name: get('name') || null, phone, consent: true, consentAt, consentSource, lastContactAt, optOut: TRUE_VALUES.has(get('opt_out').toLowerCase()) })
  })

  return { accepted, rejected }
}
