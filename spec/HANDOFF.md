# HANDOFF — retomada do wa-session-manager

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
2. Radar: `verify T08 --role tester`. Depois o Orquestrador roda `verify T08 --role operario`, **nunca os dois ao mesmo tempo**.
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
