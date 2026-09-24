// Regras puras de consentimento e opt-out (SPEC seção 9 da nota, AC-T07-03/04).
import { E164_REGEX } from '@wsm/db'

export type CannotMessageReason = 'contact_not_found' | 'opt_out' | 'no_consent'

export type CanMessageResult = { ok: true } | { ok: false; reason: CannotMessageReason }

/** Campos mínimos de um contato para decidir se ele pode receber mensagens. */
export interface ConsentFields {
  consent: boolean
  optOut: boolean
}

/**
 * Só contatos existentes, com consentimento registrado e sem opt-out podem receber mensagens.
 * Contato ausente (`null`/`undefined`) → `contact_not_found`.
 */
export function canMessage(contact: ConsentFields | null | undefined): CanMessageResult {
  if (!contact) return { ok: false, reason: 'contact_not_found' }
  if (contact.optOut) return { ok: false, reason: 'opt_out' }
  if (!contact.consent) return { ok: false, reason: 'no_consent' }
  return { ok: true }
}

export const DEFAULT_OPT_OUT_KEYWORDS = ['SAIR', 'PARAR', 'STOP', 'CANCELAR'] as const

/** Normaliza texto para comparação: sem acentos, sem pontuação/emoji nas bordas, espaços colapsados, maiúsculo. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Palavra-chave de opt-out: o texto normalizado inteiro precisa ser igual a uma das palavras. */
export function matchOptOutKeyword(
  text: string | undefined | null,
  keywords: readonly string[] = DEFAULT_OPT_OUT_KEYWORDS,
): string | undefined {
  if (!text) return undefined
  const normalized = normalizeText(text)
  if (!normalized) return undefined
  return keywords.find((k) => normalizeText(k) === normalized)
}

/** Lê palavras de opt-out de uma lista separada por vírgula (ex.: env `OPT_OUT_KEYWORDS`). Vazio → default. */
export function parseOptOutKeywords(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => normalizeText(s))
    .filter(Boolean)
  return list.length ? list : [...DEFAULT_OPT_OUT_KEYWORDS]
}

export function isE164(phone: string): boolean {
  return E164_REGEX.test(phone)
}

/**
 * Converte um JID individual do WhatsApp (`5511999999999@s.whatsapp.net`, com sufixo de device opcional)
 * para E.164. Grupos, broadcasts e LIDs → `undefined` (não há telefone).
 */
export function jidToE164(jid: string): string | undefined {
  const m = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/.exec(jid)
  if (!m) return undefined
  const phone = `+${m[1]}`
  return isE164(phone) ? phone : undefined
}
