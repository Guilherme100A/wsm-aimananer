// @wsm/core — domínio: transport, estados, segurança, warm-up, health.
// Ponto de registro compartilhado (SPEC 2.4): cada tarefa adiciona seus exports aqui.
export const CORE_PACKAGE = '@wsm/core'

// T04 — transporte (WaTransport, BaileysTransport, FakeTransport)
export * from './transport'

// T02 — criptografia de credenciais, logger com redação e auth state no Postgres
export * from './crypto'
export * from './logger'
export * from './auth-state'

// T07 — contatos e consentimento (canMessage, opt-out, import CSV, ContactsService)
export * from './contacts'

// T06 — proxies (ProxyService, createProxyChecker, resolveSessionProxy, connectSession)
export * from './proxy'
