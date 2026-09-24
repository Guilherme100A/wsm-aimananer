# HANDOFF — wa-session-manager

> **ESTADO FINAL (2026-09-24):** todas as tarefas T00-T22 estão ACCEPTED e commitadas. A regressão final serial passou nas 46 verificações (operario + tester). Não há pendências obrigatórias.

> **Como rodar:** Docker Desktop com postgres/redis via `docker compose up -d --wait postgres redis`, sempre em **127.0.0.1**, não localhost (ver spec/INFRA.md). Testes com `node spec/verify/verify.mjs <Tarefa> --role operario|tester`, uma suíte por vez; o verify.mjs já aplica VITEST_MAX_WORKERS=4, pnpm com 1 pacote por vez e as URLs 127.0.0.1. As suítes de dashboard (T12, T18-T22) compartilham o build: um agente por vez.

> **Credenciais:** troque ADMIN_PASSWORD (padrão nimda), API_TOKEN, CREDENTIALS_KEY, AUTH_SECRET e INTERNAL_TOKEN antes de produção. O `.env` não é versionado.

> O conteúdo abaixo é histórico.

> Escrito pelo Orquestrador em 2026-09-24, por volta de 02:40, antes de o humano fechar o Maestri. O estado de cada tarefa está em `spec/STATUS.md`. Este arquivo diz **como continuar**.

## Estado

11 de 17 tarefas estão ACCEPTED e commitadas.

| Tarefa                    | Estado                                                   | Commit                                       |
| ------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| T00–T04, T06, T07         | ACCEPTED                                                 | 5efb382, fbc310d, 9a8d5ac, c2fe201           |
| T05 Session Manager       | ACCEPTED (55 testes)                                     | 4412c2b                                      |
| T14 Grupos                | ACCEPTED (24)                                            | ee1fdf3                                      |
| T10 Warm-up/Health        | ACCEPTED (27)                                            | 3af9b29                                      |
| T11 Alertas               | ACCEPTED (28; verify do operário e do tester com exit 0) | f6ce91c                                      |
| **T08 Fila de mensagens** | **VERIFYING, ciclo 1**                                   | não commitado (backup no ref `refs/wip/t08`) |
| T09, T15, T13, T12, T16   | TODO                                                     | —                                            |

## T08: estado atual

* O Cinzel implementou a correção do fluxo de pausa e retomada.
* Em `packages/core/src/queue/queue.ts`, `createWorker` e `startSession` não retomam automaticamente a fila.
* Apenas `resume()` retoma a fila, seja por chamada explícita ou pela saída de `PAUSED` via evento `state`.
* A pausa é persistida no Redis.
* `pause()` e `resume()` são idempotentes e serializados por sessão.
* Foi adicionado teste unitário para o comportamento.
* `pause.test.ts` passou 10 vezes consecutivas.
* A suíte T08 passou em 22/22 nos testes do Cinzel.
* Falta executar o verify limpo:

  * `node spec/verify/verify.mjs T08 --role tester`
  * `node spec/verify/verify.mjs T08 --role operario`
* O código está na working tree, sem commit:

  * `packages/core/src/queue/**`
  * `packages/core/src/send/**`
  * `apps/worker/src/queue/**`
  * `apps/api/src/routes/messages*`
  * `tests/acceptance/T08/**`
  * linhas aditivas nos três `index.ts`
* Para recuperar alterações caso necessário:

  * `git stash apply refs/wip/t08`

## Regra de infra

Com vários agentes e suítes Vitest em paralelo, a máquina chegou a aproximadamente 2 GB de commit livre.

O Postgres apresentou encerramento por falta de memória.

**Rode verify e testes com banco UM DE CADA VEZ.**

O Orquestrador deve serializar os verifies e só solicitar o próximo quando o anterior terminar.

## Passos de retomada

1. Subir a infraestrutura:
   `node spec/verify/infra-local.mjs`

2. Utilizar Postgres e Redis conforme `spec/INFRA.md`.

3. Conferir o Postgres com:
   `pg_isready`

4. Executar o verify T08 pelo tester:
   `node spec/verify/verify.mjs T08 --role tester`

5. Depois que terminar, executar o verify T08 pelo operario:
   `node spec/verify/verify.mjs T08 --role operario`

6. Executar os verifies de forma serializada, nunca simultaneamente.

7. Se T08 passar:

   * commitar T08;
   * executar `node spec/verify/verify.mjs wave 4`;
   * marcar T08 como ACCEPTED no STATUS.

8. Despachar a onda 5 e a 6, que dependem do T08:

   * T09 Motor de segurança: Brasa / Prisma.
   * T15 Observabilidade: Cinzel / Radar.
   * Malho / Lince ficam livres para o T13 (IA assistiva, depende do T09).

9. Depois vêm:

   * T13;
   * T12 Dashboard;
   * T16 E2E.

10. O equivalente sem container para o AC-T16-01 e AC-T16-05 ainda precisa ser confirmado e registrado.

11. A cada marco, enviar o relatório com as seções 1 a 6 ao terminal **Duvidas**, que republica o painel de status.

## Equipe

* Operários: Brasa, Cinzel, Malho.
* Testers: Prisma, Radar, Lince.
* Commits somente pelo Orquestrador.

Os prompts de despacho seguem o modelo de `Txx-op.txt` / `Txx-te.txt`:

* raiz;
* infra;
* context7;
* Paths;
* não tocar em `tests/acceptance`;
* base pronta;
* contrato;
* verify;
* formato de relatório 2.3.

## Radar — Tester T08

* Os testes do T08 estão em `tests/acceptance/T08/`:

  * `env.ts`
  * `shared.ts`
  * `concurrency`
  * `lifecycle`
  * `retry`
  * `cancel`
  * `pause`
  * `single-point`
* Os testes cobrem AC-T08-01..06.
* O contrato utilizado pelo T08 está documentado no cabeçalho de `shared.ts`.
* Foi adicionado o diagnóstico `queueDiagnostics` em `shared.ts`.
* Quando `waitMsgStatus` excede o prazo, o diagnóstico apresenta:

  * `isPaused`;
  * listas/zsets do BullMQ da sessão.
* Pendente: executar o verify T08 pelo tester e reportar ao Orquestrador no formato 2.3.
* Depois, executar o verify T08 pelo operario, mantendo a execução serializada.
