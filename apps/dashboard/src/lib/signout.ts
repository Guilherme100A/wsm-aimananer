// "Sair" (AC-T18-01): revoga o token na API (falha é ignorada) e sempre limpa o token local.
import { api } from './api'
import { clearToken, getToken } from './auth'

export async function signOut(): Promise<void> {
  try {
    if (getToken()) await api.logout()
  } catch {
    // token já inválido ou API fora: sair localmente mesmo assim
  } finally {
    clearToken()
  }
}
