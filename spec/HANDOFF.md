# HANDOFF — wa-session-manager

> **ESTADO FINAL (2026-09-24):** todas as tarefas T00-T22 estão ACCEPTED e commitadas. A regressão final serial passou nas 46 verificações (operario + tester). Não há pendências obrigatórias.
>
> **Como rodar:** Docker Desktop com postgres/redis via `docker compose up -d --wait postgres redis`, sempre em **127.0.0.1**, não localhost (ver spec/INFRA.md). Testes com `node spec/verify/verify.mjs <Tarefa> --role operario|tester`, uma suíte por vez; o verify.mjs já aplica VITEST_MAX_WORKERS=4, pnpm com 1 pacote por vez e as URLs 127.0.0.1. As suítes de dashboard (T12, T18-T22) compartilham o build: um agente por vez.
>
> **Credenciais:** troque ADMIN_PASSWORD (padrão nimda), API_TOKEN, CREDENTIALS_KEY, AUTH_SECRET e INTERNAL_TOKEN antes de produção. O .env não é versionado.
>
> **Recusado e registrado (não reabrir):** entrada automática em grupos, personas por chip, IA escolhendo grupos, conversas automáticas entre chips para aquecer e técnicas para evitar a detecção de automação.
>
> O conteúdo abaixo é histórico.

> Escrito pelo Orquestrador em 2026-09-24, por volta de 02:40, antes de o humano fechar o Maestri.
> O estado de cada tarefa está em `spec/STATUS.md`. Este arquivo diz **como continuar**.

## Estado

11 de 17 tarefas estão ACCEPTED e commitadas.

| Tarefa | Estado | Commit |
|---|---|---|
| T00–T04, T06, T07 | ACCEPTED | 5efb382, fbc310d, 9a8d5ac, c2fe201 |
| T05 Session Manager | ACCEPTED (55 testes) | 4412c2b |
| T14 Grupos | ACCEPTED (24) | ee1fdf3 |
| T10 Warm-up/Health | ACCEPTED (27) | 3af9b29 |
| T11 Alertas | ACCEPTED (28; verify do operário e do tester com exit 0) | f6ce91c |
| **T08 Fila de mensagens** | **VERIFYING, ciclo 1** | não commitado (backup no ref `refs/wip/t08`) |
| T09, T15, T13, T12, T16 | TODO | — |

### T08: o que falta
- **REJECT do ciclo 1 (Radar):** no AC-T08-05, um `pause()` explícito era desfeito pelo `createWorker`, que retomava a fila quando o status no banco não era PAUSED.
- **Correção do Cinzel (feita):**
  - Em `packages/core/src/queue/queue.ts`, `createWorker` e `startSession` nunca retomam a fila. Só `resume()` retoma, seja chamado explicitamente, seja pela saída de PAUSED via evento `state`.
  - A pausa é durável no Redis. `pause()` e `resume()` são idempotentes e serializados por sessão.
  - Entrou um teste unitário novo. `pause.test.ts` passou 10 vezes seguidas e a suíte T08 passou em 22/22, segundo o Cinzel.
- **Falta:** um verify limpo, `node spec/verify/verify.mjs T08 --role tester` (Radar) e `--role operario` (Orquestrador). A última rodada falhou por **infra**, não por código: o Postgres caiu por falta de memória.
- **Código:** está na working tree, sem commit (`packages/core/src/queue/**`, `packages/core/src/send/**`, `apps/worker/src/queue/**`, `apps/api/src/routes/messages*`, `tests/acceptance/T08/**` e linhas aditivas nos três `index.ts`). Para recuperar se algo se perder: `git stash apply refs/wip/t08`.

## Regra nova de infra
Com vários agentes e suítes vitest em paralelo, a máquina ficou com cerca de 2 GB de commit livre, e o Postgres morreu com 0xC000012D / "out of memory". **Rode verify e testes com banco UM DE CADA VEZ.** O Orquestrador serializa: só pede o próximo verify quando o anterior terminar.

## Passos de retomada (em ordem)
1. Subir a infra: `node spec/verify/infra-local.mjs`, com Postgres e Redis nativos (veja `spec/INFRA.md`). Conferir com `pg_isready`.
2. **Atenção:** a Radar viu uma falha rara em `pause.test.ts` (1 em 21 execuções): depois do `resume()`, uma mensagem ficou presa em `queued`. A suspeita é uma corrida entre o `pause()/hold` de defesa do `process()` e o `resume()` do attach (veja a nota da Radar abaixo). Peça ao Cinzel para revisar isso antes do verify.
   Radar: `verify T08 --role tester`. Depois o Orquestrador roda `verify T08 --role operario`, **nunca os dois ao mesmo tempo**.
3. Se passar: commitar o T08, rodar `node spec/verify/verify.mjs wave 4` para a regressão e marcar ACCEPTED no STATUS.
   Se falhar por produto: REJECT, ciclo 2, e devolver ao Cinzel.
4. Despachar a onda 5 e a 6, que dependem do T08:
   - **T09 Motor de segurança**: Brasa / Prisma. Envolve `packages/core/src/send/deliver.ts`, usa `recordSignal(id,'forbidden_403')` do HealthMonitor e instala o `baileys-antiban`.
   - **T15 Observabilidade**: Cinzel / Radar.
   - Malho / Lince ficam livres para o T13 (IA assistiva, depende do T09).
5. Depois vêm o T13, o T12 (Dashboard) e o T16 (E2E). O humano aceitou verbalmente o equivalente sem container para o AC-T16-01 e o AC-T16-05, mas isso ainda **precisa ser confirmado** e registrado.
6. A cada marco, enviar o relatório com as seções 1 a 6 ao terminal **Duvidas**, que republica o painel de status.

## Equipe
- Operários: Brasa, Cinzel, Malho. Testers: Prisma, Radar, Lince. Commits só pelo Orquestrador.
- Os prompts de despacho seguem o modelo de `Txx-op.txt` / `Txx-te.txt`: raiz, infra, context7, Paths, "não toque em tests/acceptance", base pronta, contrato, verify e formato de relatório 2.3.

<!-- Notas dos agentes (acrescentar abaixo, uma seção por agente) -->

## Radar (Tester T08) — handoff 2026-09-24

- Testes do T08 em tests/acceptance/T08/ (env.ts, shared.ts, concurrency, lifecycle, retry, cancel, pause, single-point). Cobrem AC-T08-01..06. Contrato combinado com o Cinzel no cabeçalho de shared.ts.
- Ciclo 0: REJECT em AC-T08-05 (createWorker desfazia um pause() explícito). O Cinzel corrigiu no ciclo 1.
- Ciclo 1: pause.test.ts rodou 21 vezes: 17 passaram, 3 falharam por ambiente e 1 falhou por asserção.
  - Ambiente: memória virtual esgotada (~558MB livres, 53 processos node), com psql saindo em 0xC000012D, fork do Postgres falhando e crash do Postgres.
  - Asserção: execução 2 do 2º lote, teste "pausar com fila em andamento". Depois do resume, uma mensagem ficou em queued por mais de 15s. Não reproduziu nas 10 execuções seguintes (10/10 ok). A causa não foi confirmada.
  - Suspeita (não confirmada): process() lê status PAUSED do banco e chama pause()/hold() (queue.ts, defesa), e isso pode reordenar com o resume() do attach (disparado com `void`). Outra possibilidade é o job em hold via RateLimitError com a fila pausada.
- Adicionei o diagnóstico queueDiagnostics em shared.ts: se waitMsgStatus estourar o prazo, a mensagem de erro mostra isPaused e as listas/zsets do BullMQ da sessão.
- PENDENTE: rodar `node spec/verify/verify.mjs T08 --role tester` no ciclo 1 (não foi rodado) e reportar ao Orquestrador no formato 2.3. Se a falha em queued voltar, reportar REJECT AC-T08-05 com o diagnóstico.
