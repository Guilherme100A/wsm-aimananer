import { describe, expect, it } from 'vitest'
import { CONNECTED_STATES as CORE_CONNECTED, SESSION_INDICATORS, SESSION_STATES as CORE_STATES } from '@wsm/core'
import { CONNECTED_STATES, indicatorText, SESSION_STATES, STATE_INDICATORS, STATE_LEVEL } from './states'

describe('indicadores de estado (SPEC 3.2)', () => {
  it('iguais aos SESSION_INDICATORS do @wsm/core', () => {
    expect([...SESSION_STATES].sort()).toEqual([...CORE_STATES].sort())
    for (const s of CORE_STATES) {
      expect(STATE_INDICATORS[s]).toEqual({ icon: SESSION_INDICATORS[s].icon, label: SESSION_INDICATORS[s].label })
    }
    expect([...CONNECTED_STATES].sort()).toEqual([...CORE_CONNECTED].sort())
  })

  it.each([
    ['NEW', '⚫ New'],
    ['WARMING', '🟡 Warm-up'],
    ['STABLE', '🟢 Connected'],
    ['DEGRADED', '🟠 Degraded'],
    ['PAUSED', '🔴 Paused'],
    ['DISCONNECTED', '⚫ Disconnected'],
  ] as const)('%s → %s', (state, text) => expect(indicatorText(state)).toBe(text))

  it('cada estado tem um nível distinto no gráfico de estado', () => {
    expect(new Set(Object.values(STATE_LEVEL)).size).toBe(SESSION_STATES.length)
  })
})
