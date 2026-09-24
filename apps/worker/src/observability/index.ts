// T15 — observabilidade do worker: logger JSON com redação, servidor /health + /metrics e métricas (core).
export * from './logger'
export * from './server'
export { attachMetrics, createMetrics, type WsmMetrics } from '@wsm/core'
