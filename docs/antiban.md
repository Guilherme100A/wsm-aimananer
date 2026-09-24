# Antiban e motor de segurança (T09)

Todo envio passa por duas camadas:

1. **SendPipeline** (`packages/core/src/send/pipeline.ts`). É chamado quando a mensagem é pedida, por exemplo em `POST /api/sessions/:id/messages`. Os gates rodam em ordem fixa, e o primeiro que falha interrompe o envio com o código da SPEC 3.4:

   | Gate | Rejeição |
   |---|---|
   | `auth` | 401 `UNAUTHORIZED` (sem actor autenticado) |
   | `sessionExists` | 404 `SESSION_NOT_FOUND` |
   | `connected` | 409 `SESSION_NOT_CONNECTED` (estado fora de WARMING/STABLE ou sem transporte aberto) |
   | `contactAllowed` | 403 `CONTACT_NOT_ALLOWED` (contato inexistente, sem consentimento ou com opt-out) |
   | `warmupLimit` | 429 `WARMUP_LIMIT` (limite do dia de warm-up do T10) |
   | `rateLimit` | 429 `RATE_LIMIT` (janelas de 1 min, 1 h e 24 h) |
   | `enqueue` | enfileira na MessageQueue do T08 |

   Uma mensagem rejeitada não cria linha em `messages`. Os contadores vêm do banco: são as mensagens outbound da sessão, exceto as `cancelled`. Por isso sobrevivem a restart e valem entre processos. Dois envios simultâneos podem passar pelo mesmo último slot, porque o gate não trava linhas. Isso é aceitável porque o AntiBan limita de novo na hora da entrega.

2. **AntibanAdapter** (`packages/core/src/antiban/adapter.ts`), chamado na entrega (`send/deliver.ts`). `deliver.ts` é o **único** lugar que chama `transport.sendMessage` (AC-T09-04). A sequência de cada envio é `beforeSend` → espera de `delayMs` → `sendMessage` → `afterSend` (ou `afterSendFailed`). Se o adapter nega o envio, nada é enviado e é lançado `AntibanBlockedError` (`ANTIBAN_BLOCKED`); a fila do T08 trata isso como falha/retry. Um erro 403 no envio grava `recordSignal(sessionId, 'forbidden_403')` no HealthMonitor e reduz os limites da sessão em ×0,5. As duas dependências são injetadas via `createDeliver({ health, limits })`.

## API real do baileys-antiban (v4.10.0)

A spec só previa "delays/limites". A API real é esta:

- `new AntiBan(input?)`, onde `input` é um preset (`'conservative' | 'moderate' | 'aggressive' | 'high-volume'`) ou uma config plana (`{ preset?, maxPerMinute, maxPerHour, maxPerDay, minDelayMs, maxDelayMs, newChatDelayMs, maxIdenticalMessages, burstAllowance, warmupDays, day1Limit, growthFactor, logging, ... }`). A config aninhada da v2 (`{ rateLimiter: {...} }`) está deprecada e emite `console.warn`.
- `beforeSend(recipient, content: string)` → `{ allowed, delayMs, reason?, health, warmUpDay? }`. Quem chama é que espera `delayMs`.
- `afterSend(recipient, content, msgId?)`, `afterSendFailed(error?)`, `onDisconnect(reason)`, `onReconnect()`, `onDeliveryReceipt(msgId)`, `exportState()/importState()`, `destroy()`.
- O **conteúdo é uma string**. O adapter converte `OutgoingContent` com `contentFingerprint`: texto, legenda ou uma assinatura estável da mídia.
- `logging: true` (default dos presets) escreve com `console.log`. O adapter força `logging: false`.
- O estado do AntiBan fica **em memória** e não é persistido (não usamos a opção `persist`). O adapter mantém uma instância por sessão.
- Com o preset `conservative`: 5/min, 100/h, 800/dia, 2,5–7 s entre mensagens, +2–4 s no primeiro envio para um contato novo, e bloqueio após 3 mensagens idênticas em 1 h. O próprio AntiBan tem um warm-up interno (10 dias, 15 no dia 1) contado desde que a instância é criada. Ele pode ser **mais restritivo** que o cronograma do T10, mas nunca mais permissivo, porque os dois precisam permitir o envio.
- O pacote também tem módulos que geram atividade (`legitimacySignalInjector`, `contentVariator`, auto-reply de `replyRatio`, `presenceChoreographer`). **Não os usamos.** Fabricar conversas ou mensagens para "aquecer" é proibido (SPEC 1.4 #5).

A interface do adapter (`AntibanAdapter`: `beforeSend`, `afterSend`, `afterSendFailed`, `stats`, `mode`) não depende dessa API. Se a biblioteca mudar, só `BaileysAntibanAdapter` muda.

## Configuração

| Variável | Valores | Default |
|---|---|---|
| `ANTIBAN_MODE` | `real`, `passthrough` | `real` |
| `ANTIBAN_PRESET` | `conservative`, `moderate`, `aggressive`, `high-volume` | `conservative` |

- **`real`** usa o baileys-antiban de verdade. É o default: um deploy sem configuração **nunca** desliga o antiban. Valor inválido faz o processo falhar no boot (`AntibanConfigError`).
- **`passthrough`** existe **somente para testes**. Chama os mesmos hooks e conta os envios (`adapter.stats(sessionId)`), mas não espera nem bloqueia. Quando é criado, registra um warn `antiban em passthrough`. O código de produção nunca escolhe o modo a partir de `NODE_ENV`/`VITEST`: as suítes ligam o passthrough explicitamente, em `tests/acceptance/vitest.config.ts` e no `vitest.config.ts` de `packages/core`, `apps/api` e `apps/worker`.
- `defaultAntibanAdapter()` é o adapter do processo, criado a partir do ambiente no primeiro uso. É o que o `deliver` padrão usa. Os testes do modo real injetam `sleep` em `createDeliver({ antiban: new BaileysAntibanAdapter(), sleep })` e exercitam os delays e o bloqueio por mensagens idênticas sem esperar.

## Limites por sessão (AC-T09-05)

- A tabela `session_limits` (migration `0001_session_limits`) guarda os limites configurados (`perMinute`, `perHour`, `perDay`; `NULL` = default) e o `reduction_factor`.
- Os defaults conservadores são **5/min, 100/h e 800/dia**, iguais ao preset `conservative`.
- `GET /api/sessions/:id/limits` devolve `{ configured, defaults, reductionFactor, reductionReason, reducedAt, degraded, warmup, effective }`.
- `PUT /api/sessions/:id/limits` recebe `{ perMinute?, perHour?, perDay? }`. É a **única** forma de aumentar limites: é manual, fica auditado e zera a redução.
- **Redução automática:** `SessionLimitsService.reduce(sessionId, factor, reason)` só diminui o fator, com piso de 0,1. O `deliver` chama `reduce(..., 0.5)` após um 403. Enquanto a sessão está `DEGRADED`, os limites efetivos caem pela metade, sem gravar no banco.
- **Nunca acima do warm-up:** `effective.perDay = min(configurado, limite do dia de warm-up) × fator`. `perHour` e `perMinute` valem `configurado × fator`. Configurar valores acima do cronograma é aceito, mas não aumenta o efetivo.

## Integração no worker (boot, T16)

```ts
const limits = new SessionLimitsService(db)
const queue = new MessageQueue({
  db,
  getTransport: (id) => manager.getTransport(id),
  deliver: createDeliver({ health: healthMonitor, limits }), // adapter padrão: ANTIBAN_MODE (default real)
})
```

O Health Score continua sendo **apenas** um indicador operacional. Nenhuma camada deste sistema garante que a conta não será restringida pelo WhatsApp.
