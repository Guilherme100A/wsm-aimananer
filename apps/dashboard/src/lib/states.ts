// Indicadores de estado da sessão: exatamente a tabela 3.2 da SPEC (espelha SESSION_INDICATORS do @wsm/core).
import type { SessionState } from './types'

export const STATE_INDICATORS: Record<SessionState, { icon: string; label: string }> = {
  NEW: { icon: '⚫', label: 'New' },
  WARMING: { icon: '🟡', label: 'Warm-up' },
  STABLE: { icon: '🟢', label: 'Connected' },
  DEGRADED: { icon: '🟠', label: 'Degraded' },
  PAUSED: { icon: '🔴', label: 'Paused' },
  DISCONNECTED: { icon: '⚫', label: 'Disconnected' },
}

export const SESSION_STATES = Object.keys(STATE_INDICATORS) as SessionState[]

/** Texto "<ícone> <rótulo>". */
export function indicatorText(state: SessionState): string {
  const i = STATE_INDICATORS[state]
  return i ? `${i.icon} ${i.label}` : state
}

/** Conta autenticada com conexão esperada (card "conectadas"). */
export const CONNECTED_STATES: readonly SessionState[] = ['WARMING', 'STABLE', 'DEGRADED', 'PAUSED']
/** Card "desconectadas". */
export const DISCONNECTED_STATES: readonly SessionState[] = ['NEW', 'DISCONNECTED']

/** Posição do estado no gráfico de estado (eixo Y). */
export const STATE_LEVEL: Record<SessionState, number> = {
  DISCONNECTED: 0,
  NEW: 1,
  PAUSED: 2,
  DEGRADED: 3,
  WARMING: 4,
  STABLE: 5,
}
