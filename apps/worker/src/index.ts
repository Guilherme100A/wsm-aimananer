// @wsm/worker — sessões Baileys, filas, monitor de saúde e alertas.
// Ponto de registro compartilhado (SPEC 2.4): cada tarefa registra seus módulos aqui.
import { CORE_PACKAGE } from '@wsm/core'

export const WORKER_PACKAGE = '@wsm/worker'
export const dependsOn = [CORE_PACKAGE]
