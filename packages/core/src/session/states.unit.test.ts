import { describe, expect, it } from 'vitest'
import { SESSION_STATUSES } from '@wsm/db'
import {
  ACTION_SOURCES,
  assertAction,
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isSessionState,
  SESSION_INDICATORS,
  SESSION_STATES,
  type SessionState,
} from './states'

// Tabela da SPEC 3.2 (from → to permitidos).
const allowed: Array<[SessionState, SessionState]> = [
  ['NEW', 'WARMING'],
  ['WARMING', 'STABLE'],
  ['WARMING', 'DEGRADED'],
  ['STABLE', 'DEGRADED'],
  ['DEGRADED', 'WARMING'],
  ['DEGRADED', 'STABLE'],
  ['WARMING', 'PAUSED'],
  ['STABLE', 'PAUSED'],
  ['DEGRADED', 'PAUSED'],
  ['PAUSED', 'WARMING'],
  ['PAUSED', 'STABLE'],
  ['NEW', 'DISCONNECTED'],
  ['WARMING', 'DISCONNECTED'],
  ['STABLE', 'DISCONNECTED'],
  ['DEGRADED', 'DISCONNECTED'],
  ['PAUSED', 'DISCONNECTED'],
  ['DISCONNECTED', 'NEW'],
]

describe('máquina de estados da sessão', () => {
  it('estados iguais aos do enum do banco', () => {
    expect([...SESSION_STATES]).toEqual([...SESSION_STATUSES])
    for (const s of SESSION_STATES) expect(SESSION_INDICATORS[s].icon).toBeTruthy()
  })

  it('aceita exatamente as transições da SPEC 3.2', () => {
    for (const from of SESSION_STATES) {
      for (const to of SESSION_STATES) {
        const expected = allowed.some(([f, t]) => f === from && t === to)
        expect(canTransition(from, to), `${from} → ${to}`).toBe(expected)
      }
    }
  })

  it('assertTransition lança INVALID_TRANSITION', () => {
    expect(() => assertTransition('NEW', 'PAUSED')).toThrow(InvalidTransitionError)
    expect(() => assertTransition('DISCONNECTED', 'WARMING')).toThrow(/DISCONNECTED → WARMING/)
    try {
      assertTransition('STABLE', 'STABLE')
    } catch (err) {
      expect((err as InvalidTransitionError).code).toBe('INVALID_TRANSITION')
    }
    expect(() => assertTransition('PAUSED', 'STABLE')).not.toThrow()
  })

  it('ações manuais respeitam as origens válidas', () => {
    expect(() => assertAction('pause', 'NEW')).toThrow(InvalidTransitionError)
    expect(() => assertAction('pause', 'PAUSED')).toThrow(InvalidTransitionError)
    expect(() => assertAction('resume', 'STABLE')).toThrow(InvalidTransitionError)
    expect(() => assertAction('logout', 'DISCONNECTED')).toThrow(InvalidTransitionError)
    expect(() => assertAction('restart', 'DISCONNECTED')).toThrow(InvalidTransitionError)
    expect(() => assertAction('connect', 'WARMING')).toThrow(InvalidTransitionError)
    // pause/resume só usam origens cuja transição é permitida
    for (const from of ACTION_SOURCES.pause) expect(canTransition(from, 'PAUSED')).toBe(true)
    for (const from of ACTION_SOURCES.logout) expect(canTransition(from, 'DISCONNECTED')).toBe(true)
  })

  it('isSessionState', () => {
    expect(isSessionState('STABLE')).toBe(true)
    expect(isSessionState('stable')).toBe(false)
    expect(isSessionState(1)).toBe(false)
  })
})
