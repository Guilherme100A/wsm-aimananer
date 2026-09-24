// @wsm/worker — sessões Baileys, filas, monitor de saúde e alertas.
// Ponto de registro compartilhado (SPEC 2.4): cada tarefa registra seus módulos aqui.
import { CORE_PACKAGE } from '@wsm/core'

export const WORKER_PACKAGE = '@wsm/worker'
export const dependsOn = [CORE_PACKAGE]

// T07 — opt-out por mensagem recebida
export * from './optout'

// T06 — monitor de proxies (verificador periódico, evento proxy_unavailable)
export * from './proxy'
