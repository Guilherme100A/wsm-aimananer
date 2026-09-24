// Handler de opt-out (AC-T07-03): plugue em `transport.on('message', handler)`.
// Só marca opt_out=true (nunca reverte) e grava auditoria `contact.opt_out`.
import {
  ContactsService,
  DEFAULT_OPT_OUT_KEYWORDS,
  jidToE164,
  matchOptOutKeyword,
  type IncomingMessage,
  type OptOutResult,
} from '@wsm/core'
import type { Database } from '@wsm/db'

export interface OptOutLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

export interface OptOutHandlerOptions {
  db: Database
  /** Palavras de opt-out (comparação após normalização). Default: SAIR, PARAR, STOP, CANCELAR. */
  keywords?: readonly string[]
  /** Sessão que recebeu a mensagem (vai para o detalhe da auditoria). */
  sessionId?: string
  logger?: OptOutLogger
}

export type OptOutHandlerResult =
  | { handled: false; reason: 'from_me' | 'not_keyword' | 'no_phone' }
  | ({ handled: true; keyword: string; phone: string } & OptOutResult)

export function createOptOutHandler(opts: OptOutHandlerOptions) {
  const service = new ContactsService(opts.db)
  const keywords = opts.keywords?.length ? opts.keywords : DEFAULT_OPT_OUT_KEYWORDS

  return async function handleOptOut(msg: IncomingMessage): Promise<OptOutHandlerResult> {
    if (msg.fromMe) return { handled: false, reason: 'from_me' }
    const keyword = matchOptOutKeyword(msg.text, keywords)
    if (!keyword) return { handled: false, reason: 'not_keyword' }
    // Grupos/LIDs não têm telefone: o pedido não pode ser associado a um contato.
    const phone = jidToE164(msg.from)
    if (!phone) {
      opts.logger?.warn({ session_id: opts.sessionId, message_id: msg.id }, 'opt-out keyword from non-phone JID ignored')
      return { handled: false, reason: 'no_phone' }
    }
    const result = await service.recordOptOut(phone, { keyword, sessionId: opts.sessionId, messageId: msg.id })
    opts.logger?.info(
      { session_id: opts.sessionId, contact_id: result.contact.id, changed: result.changed, created: result.created },
      'contact opted out',
    )
    return { handled: true, keyword, phone, ...result }
  }
}
