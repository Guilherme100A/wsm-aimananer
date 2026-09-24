// Mensagens da tela de login (AC-T18-01).
import { ApiRequestError } from './api'

export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 401) return 'Usuário ou senha inválidos'
    if (err.status === 429) return 'Muitas tentativas. Tente novamente mais tarde.'
    if (err.status === 400) return 'Informe usuário e senha'
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}
