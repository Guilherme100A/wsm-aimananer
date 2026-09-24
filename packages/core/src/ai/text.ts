// Normalização e hash do texto recebido (chave do cache da IA, AC-T13-04).
import { createHash } from 'node:crypto'

/** trim + lowercase + espaços colapsados. */
export function normalizeAiText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** SHA-256 (hex) do texto normalizado. */
export function hashAiText(s: string): string {
  return createHash('sha256').update(normalizeAiText(s), 'utf8').digest('hex')
}

/** Alias de `hashAiText`. */
export const hashText = hashAiText
