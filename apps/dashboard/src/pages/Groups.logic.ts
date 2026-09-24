// T20 — "Adicionar número" na página Grupos: cliente da rota e textos de resultado.
// Ação manual, um número por vez, com confirmação; nada é disparado sem o clique do usuário.
import { ApiRequestError, request } from '../lib/api'
import type { Group, Session } from '../lib/types'

/** Grupo com a informação de admin devolvida pela API (T20). */
export type GroupWithAdmin = Group & { isAdmin?: boolean }

export type GroupAddResult =
  | 'added'
  | 'already_member'
  | 'not_allowed'
  | 'failed'
  | 'not_admin'
  | 'group_not_found'
  | 'rate_limited'
  | 'not_connected'
  | 'target_not_found'
  | 'invalid_target'
  | 'error'

export interface GroupAddResponse {
  result: 'added' | 'already_member' | 'not_allowed' | 'failed'
  groupId: string
  targetSessionId: string
  jid: string
  code?: number
}

export const groupsAddApi = {
  add: (sessionId: string, groupId: string, targetSessionId: string) =>
    request<GroupAddResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(groupId)}/participants`, {
      method: 'POST',
      body: { targetSessionId },
    }),
}

export const NOT_ADMIN_HINT = 'A sessão não é admin deste grupo: somente admins podem adicionar números.'

const TEXTS: Record<GroupAddResult, string> = {
  added: 'Número adicionado ao grupo.',
  already_member: 'Já é membro do grupo.',
  not_allowed: 'O número não permite ser adicionado a grupos (privacidade).',
  failed: 'Falha ao adicionar o número.',
  not_admin: 'Não é admin do grupo.',
  group_not_found: 'Grupo não encontrado.',
  rate_limited: 'Limite: 1 adição por minuto. Tente novamente em instantes.',
  not_connected: 'A sessão não está conectada.',
  target_not_found: 'Sessão alvo não encontrada.',
  invalid_target: 'Escolha outra sessão (diferente da sessão admin e com telefone).',
  error: 'Erro ao adicionar.',
}

export function resultText(result: GroupAddResult): string {
  return TEXTS[result]
}

/** Resultado a partir da resposta ou do erro da API. */
export function resultFromError(err: unknown): GroupAddResult {
  if (!(err instanceof ApiRequestError)) return 'error'
  switch (err.code) {
    case 'NOT_GROUP_ADMIN':
      return 'not_admin'
    case 'GROUP_NOT_FOUND':
      return 'group_not_found'
    case 'RATE_LIMIT':
      return 'rate_limited'
    case 'SESSION_NOT_CONNECTED':
      return 'not_connected'
    case 'SESSION_NOT_FOUND':
      return 'target_not_found'
    case 'VALIDATION_ERROR':
      return 'invalid_target'
    default:
      return 'error'
  }
}

/** Sessões do sistema que podem ser alvo: todas, exceto a própria sessão admin. */
export function targetOptions(sessions: Session[], adminSessionId: string): Session[] {
  return sessions.filter((s) => s.id !== adminSessionId && Boolean(s.phone))
}

export const sessionLabel = (s: Pick<Session, 'name' | 'phone'>) => `${s.name} (${s.phone})`

export function confirmText(target: Pick<Session, 'name' | 'phone'>, group: Pick<Group, 'name' | 'id'>): string {
  return `Adicionar ${sessionLabel(target)} ao grupo ${group.name || group.id}?`
}
