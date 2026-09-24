// Ponto ÚNICO de entrega ao transporte (SPEC 1.4 #2, AC-T08-06). O T09 envolve esta função com o
// pipeline do Motor de Segurança e o AntibanAdapter; a fila (T08) só entrega por aqui.
import type { OutgoingContent, WaTransport } from '../transport'

/** Assinatura da entrega: injetável na fila (spies em teste, wrapper do T09 em produção). */
export type DeliverFn = (transport: WaTransport, to: string, content: OutgoingContent) => Promise<{ messageId: string }>

export const deliver: DeliverFn = (transport, to, content) => transport.sendMessage(to, content)
