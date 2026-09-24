# STATUS — WhatsApp Session Manager

> Mantido pelo **Orquestrador**. Estados: `TODO` · `IN_PROGRESS` · `VERIFYING` · `REJECTED` · `BLOCKED` · `ACCEPTED`.
> Verify: `node spec/verify/verify.mjs list` mostra o resultado dos últimos relatórios.

| Onda | Tarefa | Título                                     | Estado   | Operário | Tester | Ciclos | Notas                                                                                                         |
| ---- | ------ | ------------------------------------------ | -------- | -------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| 0    | T00    | Scaffold do monorepo                       | ACCEPTED | Brasa    | Prisma | 0      | 24 testes; sugestão: `.dockerignore` no T16                                                                   |
| 1    | T01    | Schema do banco                            | ACCEPTED | Cinzel   | Radar  | 0      | 14 testes                                                                                                     |
| 1    | T03    | Esqueleto da API                           | ACCEPTED | Malho    | Lince  | 0      | 23 testes                                                                                                     |
| 1    | T04    | Abstração de transporte                    | ACCEPTED | Brasa    | Prisma | 0      | 34 testes                                                                                                     |
| 2    | T02    | Criptografia e auth state                  | ACCEPTED | Brasa    | Prisma | 0      | 43 testes; `initCredentialsCrypto()` no boot                                                                  |
| 2    | T06    | Proxies                                    | ACCEPTED | Malho    | Lince  | 0      | 26 testes; DELETE de proxy vinculado→409; T05 usa `connectSession/resolveSessionProxy`                        |
| 2    | T07    | Contatos e consentimento                   | ACCEPTED | Cinzel   | Radar  | 0      | 27 testes; dup phone→400; opt-out de desconhecido cria contato bloqueado; import não sobrescreve              |
| 3    | T05    | Session Manager                            | ACCEPTED | Brasa    | Prisma | 0      | 55 testes; hooks `onConnected/onDisconnected` e `resumeState` p/ T10; `getTransport(id)` p/ T08/T14           |
| 4    | T08    | Fila de mensagens                          | ACCEPTED | Cinzel   | Radar  | 2      | 22 testes; pausa durável + hold no processador; `SessionQueueControl` p/ T10; `deliver.ts` ponto único p/ T09 |
| 4    | T10    | Warm-up e Health Monitor                   | ACCEPTED | Malho    | Lince  | 0      | 27 testes; `HealthMonitor.attach(manager)`, evento alert p/ T11, `recordSignal` p/ T09                        |
| 5    | T09    | Motor de segurança                         | ACCEPTED | Brasa    | Prisma | 1      | 58 testes; `ANTIBAN_MODE` default real; migration `0001 session_limits`; ciclo 1 corrigido                    |
| 5    | T11    | Alertas                                    | ACCEPTED | Malho    | Lince  | 0      | 28 testes; segredos cifrados (T02); `POST /api/webhooks/:id/test`                                             |
| 5    | T14    | Grupos                                     | ACCEPTED | Brasa    | Prisma | 0      | 24 testes; ação manual `POST /groups/refresh` auditada                                                        |
| 6    | T13    | IA assistiva                               | ACCEPTED | Malho    | Lince  | 0      | 28 testes; inbound persistido; opt-out ligado; migration `0002 suggestions`                                   |
| 6    | T15    | Observabilidade                            | ACCEPTED | Cinzel   | Radar  | 0      | 16 testes; `/metrics` Prometheus, healthchecks nos 5 serviços, logs JSON com `session_id`                     |
| 6    | T12    | Dashboard                                  | ACCEPTED | Malho    | Lince  | 0      | 23 testes Playwright; commit junto com T09/T15                                                                |
| 7    | T16    | Integração E2E                             | ACCEPTED | Brasa    | Prisma | 0      | 18 testes contra stack Docker; subida ~13 s; restart sem perda/duplicata                                      |
| 8    | T17    | Login admin e proxy na sessão (API)        | ACCEPTED | Malho    | Lince  | 1      | 37 testes; `TRUST_PROXY`; portas internas somente em `127.0.0.1`                                              |
| 8    | T18    | Dashboard: login admin e proxy no cadastro | ACCEPTED | Cinzel   | Radar  | 0      | 23 testes; T12 atualizado e verde                                                                             |
| 8    | T19    | Configurações do modelo de LLM             | ACCEPTED | Brasa    | Prisma | 0      | 55 testes; migration `0003 ai_settings`; worker relê config a cada 5 s                                        |
| 8    | T20    | Adicionar número a grupo (manual)          | ACCEPTED | Brasa    | Prisma | 0      | 44 testes; 1 alvo por requisição, 1/min por admin, auditado, ponte entre containers                           |
| 8    | T21    | Redesign do dashboard                      | ACCEPTED | Nácar    | Íris   | 0      | 22 testes; critérios em `docs/dashboard-design.md`; regressão T12/T18/T19/T20 verde                           |
| 8    | T22    | Chip pessoal / conexão direta              | ACCEPTED | Nácar    | Íris   | 0      | 12 testes; checkbox padrão marcada; testes T12/T18/T21 ajustados                                              |

## Decisões e infraestrutura

<!-- Data · Tarefa · Decisão/estado · Responsável -->

* 2026-09-24 · FINAL · Regressão final serial T00-T22, operário + tester: 46 verificações. Todas concluídas após correção de infraestrutura. T00-T22 ACCEPTED.
* 2026-09-24 · FINAL · `verify.mjs` passou a exportar `DATABASE_URL`/`REDIS_URL` usando `127.0.0.1`, além dos helpers `pg.ts`, `.env.example` e `INFRA.md`.
* 2026-09-24 · harness · Causa dos `page.goto` pendurados: o servidor do harness lia o arquivo depois de `writeHead`; rebuild concorrente podia gerar `ERR_HTTP_HEADERS_SENT`. Corrigido com leitura antes do cabeçalho, lock de build e cópia privada do dist por servidor.
* 2026-09-24 · T22 · Checkbox "Chip pessoal / conexão direta" adicionada, marcada por padrão. Sessão sem proxy conecta diretamente. AC-T06-05 permanece para sessões com proxy.
* 2026-09-24 · equipe · Nácar e Íris adicionados para o redesign do dashboard. Alterações restritas a `apps/dashboard/**`, preservando os `data-testid`.
* 2026-09-24 · onda 8 · Regressão serial após T17/T18/T19: T01 op/te, T03, T05, T06, T13, T12 e T16 op verificados.
* 2026-09-24 · T17 · Docker Compose publica Postgres, Redis, API e worker somente em `127.0.0.1`; dashboard permanece exposto na rede.
* 2026-09-24 · T17 · Login utiliza `ADMIN_USERNAME`/`ADMIN_PASSWORD`; token de login assinado com expiração; `API_TOKEN` permanece disponível para integrações; `/api/proxies` mantido por compatibilidade.
* 2026-09-24 · T17 · Rate limit de login utiliza `TRUST_PROXY`; com `TRUST_PROXY=true`, considera o salto confiável mais à direita.
* 2026-09-24 · T19 · Configuração do LLM implementada na T19; worker relê configuração a cada 5 segundos.
* 2026-09-24 · T13 · Inbound persistido em `messages` com `direction=inbound`, `status=delivered` e `transport_message_id`; migration aditiva `0002_suggestions`.
* 2026-09-24 · T13 · Opt-out do T07 conectado ao fluxo de IA antes do processamento.
* 2026-09-24 · T15 · `/metrics` Prometheus, healthchecks dos cinco serviços e logs JSON com `session_id`.
* 2026-09-24 · T15 · `@opentelemetry/api` adicionado aos pacotes necessários para unificar a variante do `drizzle-orm`.
* 2026-09-24 · T09 · `deliver.ts` utiliza `AntibanAdapter`; `ANTIBAN_MODE=real|passthrough`, com `real` como padrão e `passthrough` explícito nos testes.
* 2026-09-24 · T08 · Corrida de `pause/resume` corrigida; `process()` não pausa mais a fila; o hold ocorre dentro do processador; `runRetryDelay` configurado para 1 s.
* 2026-09-24 · T08 · `DEGRADED` impede novos envios; cancelamento de mensagem inexistente retorna `404 NOT_FOUND`.
* 2026-09-24 · T10 · Warm-up utiliza `WarmUpConfig` configurável por `WARMUP_*`; `health_events` utiliza `now()` do banco.
* 2026-09-24 · T14 · Estados de grupo: `announce|open`; operação fora dos estados permitidos retorna `409 SESSION_NOT_CONNECTED`; ação de atualização de grupos é manual e auditada.
* 2026-09-24 · T05 · Restart preserva estado; logout em estado desconectado retorna 409; QR/pairing disponível em NEW/DISCONNECTED; `forbidden` leva NEW→DISCONNECTED; `loggedOut` remove credenciais.
* 2026-09-24 · regressão · Testes unitários do DB estavam fixando quantidade antiga de tabelas/migrations; atualização corrigida no ciclo de regressão.
* 2026-09-24 · infra · `verify.mjs` limita Vitest a `VITEST_MAX_WORKERS=4`; execução dos verifies deve permanecer serializada para reduzir consumo de memória.
* 2026-09-24 · infra · Docker passou a ser utilizado para Postgres/Redis nos testes; serviços nativos devem permanecer parados durante essa execução.
* 2026-09-24 · infra · OOM anterior foi associado à execução paralela de múltiplas suítes Vitest e aos builds da stack.
* 2026-09-24 · equipe · Commits são realizados somente pelo Orquestrador.

## Escalonamentos ao humano

<!-- Data · Tarefa · Motivo · Relatório (spec/reports/...) -->

Nenhum escalonamento pendente.
