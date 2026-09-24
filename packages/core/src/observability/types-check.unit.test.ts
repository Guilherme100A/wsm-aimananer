// Garante (em tempo de compilação) que MessageQueue e emissores tipados são aceitos por attachMetrics.
import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import type { Database } from '@wsm/db'
import { MessageQueue } from '../queue'
import { attachMetrics, createMetrics } from './metrics'

it('tipos: MessageQueue e EventEmitter tipado', () => {
  const typed = new EventEmitter<{ state: [{ sessionId: string; to: 'NEW' }]; disconnected: [{ sessionId: string; reason: string }] }>()
  const build = () => attachMetrics({ metrics: createMetrics(), queue: new MessageQueue({ db: {} as Database }), manager: typed })
  expect(typeof build).toBe('function')
})
