// Token da API em memória + sessionStorage (AC-T12-01). Nunca em localStorage nem cookie.
export const TOKEN_KEY = 'wsm.token'

let memory: string | null = null
const listeners = new Set<() => void>()

function storage(): Storage | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

export function getToken(): string | null {
  if (memory) return memory
  try {
    memory = storage()?.getItem(TOKEN_KEY) ?? null
  } catch {
    memory = null
  }
  return memory
}

export function setToken(token: string): void {
  memory = token
  try {
    storage()?.setItem(TOKEN_KEY, token)
  } catch {
    // sem sessionStorage (modo privado): fica só em memória
  }
  for (const l of listeners) l()
}

export function clearToken(): void {
  memory = null
  try {
    storage()?.removeItem(TOKEN_KEY)
  } catch {
    // ignore
  }
  for (const l of listeners) l()
}

export function onTokenChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
