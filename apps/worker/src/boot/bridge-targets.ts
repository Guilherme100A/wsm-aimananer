// Alvos da ponte interna (T16) montados a partir das peças do worker. T20: sessions.addGroupParticipant usa o
// GroupParticipantService (checagens, admin, freio de 1/min e transporte da sessão admin).
import { GroupParticipantService, type MessageQueue } from '@wsm/core'
import type { Database } from '@wsm/db'
import type { HealthMonitor } from '../health'
import type { SessionManager } from '../sessions'
import type { BridgeTargets } from './internal-server'

export interface CreateBridgeTargetsOptions {
  manager: SessionManager
  queue: MessageQueue
  health: Pick<HealthMonitor, 'getHealth'>
  db: Database
  /** Relógio (ms) do freio de adições a grupo (testes). */
  groupAddNow?: () => number
}

export function createBridgeTargets(opts: CreateBridgeTargetsOptions): BridgeTargets & { groupParticipants: GroupParticipantService } {
  const { manager } = opts
  const groupParticipants = new GroupParticipantService({
    db: opts.db,
    getTransport: (id) => (manager.isConnected(id) ? manager.getTransport(id) : undefined),
    ...(opts.groupAddNow ? { now: opts.groupAddNow } : {}),
  })
  const sessions: BridgeTargets['sessions'] = {
    create: (input) => manager.create(input),
    list: () => manager.list(),
    get: (id) => manager.get(id),
    startQr: (id) => manager.startQr(id),
    getQr: (id) => manager.getQr(id),
    requestPairingCode: (id, phone) => manager.requestPairingCode(id, phone),
    pause: (id) => manager.pause(id),
    resume: (id) => manager.resume(id),
    restart: (id) => manager.restart(id),
    logout: (id) => manager.logout(id),
    getTransport: (id) => manager.getTransport(id),
    isConnected: (id) => manager.isConnected(id),
    addGroupParticipant: (adminSessionId, groupId, targetSessionId) => groupParticipants.add({ adminSessionId, groupId, targetSessionId }),
  }
  return { sessions, messages: opts.queue, health: opts.health, groupParticipants }
}
