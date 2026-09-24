# STATUS — WhatsApp Session Manager

> Mantido pelo **Orquestrador**. Estados: `TODO` · `IN_PROGRESS` · `VERIFYING` · `REJECTED` · `BLOCKED` · `ACCEPTED`.
> Verify: `node spec/verify/verify.mjs list` mostra o resultado dos últimos relatórios.

| Onda | Tarefa | Título | Estado | Operário | Tester | Ciclos | Notas |
|---|---|---|---|---|---|---|---|
| 0 | T00 | Scaffold do monorepo | ACCEPTED | Brasa | Prisma | 0 | 24 testes; sugestão: .dockerignore no T16 |
| 1 | T01 | Schema do banco | ACCEPTED | Cinzel | Radar | 0 | 14 testes |
| 1 | T03 | Esqueleto da API | ACCEPTED | Malho | Lince | 0 | 23 testes |
| 1 | T04 | Abstração de transporte | ACCEPTED | Brasa | Prisma | 0 | 34 testes |
| 2 | T02 | Criptografia e auth state | ACCEPTED | Brasa | Prisma | 0 | 43 testes; initCredentialsCrypto() no boot |
| 2 | T06 | Proxies | ACCEPTED | Malho | Lince | 0 | 26 testes; DELETE de proxy vinculado→409; T05 deve usar connectSession/resolveSessionProxy |
| 2 | T07 | Contatos e consentimento | ACCEPTED | Cinzel | Radar | 0 | 27 testes; decisões: dup phone→400, opt-out de desconhecido cria contato bloqueado, import não sobrescreve |
| 3 | T05 | Session Manager | ACCEPTED | Brasa | Prisma | 0 | 55 testes; hooks onConnected/onDisconnected e resumeState p/ T10; getTransport(id) p/ T08/T14 |
| 4 | T08 | Fila de mensagens | VERIFYING | Cinzel | Radar | 1 | correção do AC-T08-05 feita (pausa durável); falta verify tester/operário limpo (infra caiu por falta de memória) |
| 4 | T10 | Warm-up e Health Monitor | ACCEPTED | Malho | Lince | 0 | 27 testes; HealthMonitor.attach(manager), evento alert p/ T11, recordSignal p/ T09 |
| 5 | T09 | Motor de segurança | TODO | | | 0 | |
| 5 | T11 | Alertas | ACCEPTED | Malho | Lince | 0 | 28 testes; segredos cifrados (T02); POST /api/webhooks/:id/test extra |
| 5 | T14 | Grupos | ACCEPTED | Brasa | Prisma | 0 | 24 testes; adiantado; única ação manual: POST /groups/refresh (auditada) |
| 6 | T13 | IA assistiva | TODO | | | 0 | |
| 6 | T15 | Observabilidade | TODO | | | 0 | |
| 6 | T12 | Dashboard | TODO | | | 0 | |
| 7 | T16 | Integração E2E | TODO | | | 0 | |

## Bloqueios e decisões

<!-- Data · Tarefa · Pergunta/decisão · Quem decidiu -->
- 2026-09-24 · infra · Humano instalou o Docker. O verify passa a usar docker compose (postgres/redis em containers), e os serviços nativos ficam parados. O AC-T16-01/05 foi desbloqueado. Retomada: o Cinzel revisa a corrida residual do T08 (nota da Radar) antes do verify. · Humano/Orquestrador
- 2026-09-24 · infra · Postgres local caiu várias vezes por falta de memória (commit ~2 GB livre) com 3 suítes em paralelo. Regra: rodar verify/testes com banco UM DE CADA VEZ. · Orquestrador
- 2026-09-24 · pausa · Humano fechou o Maestri ~02:35. Próximo: re-verificar T08 (tester e operário, serializado), commitar T08 (código na working tree, não commitado), despachar T09 e T15. · Orquestrador
- 2026-09-24 · T08 · Decisões aceitas: DEGRADED segura envios (3.4); cancel de mensagem inexistente→404 NOT_FOUND (lacuna 3.4). Risco p/ T16: worker que cai no meio do envio deixa mensagem em processing (sem reenvio para evitar duplicata). · Orquestrador
- 2026-09-24 · T10 · Warm-up = WarmUpConfig do baileys-antiban (7 dias, 20/dia inicial, x1.8), configurável por WARMUP_*; pacote baileys-antiban fica para o T09. health_events usam now() do banco. · Orquestrador
- 2026-09-24 · T14 · Decisões aceitas: status de grupo announce|open; 409 SESSION_NOT_CONNECTED fora de WARMING/STABLE (inclui DEGRADED/PAUSED, SPEC 3.4 literal); única ação manual = refresh (WaTransport só tem fetchGroups). · Orquestrador
- 2026-09-24 · T05 · Decisões aceitas: mesmo estado não é transição (logout em DISCONNECTED→409); restart mantém estado, 409 em DISCONNECTED; QR/pairing só em NEW/DISCONNECTED; resume PAUSED→WARMING (T10 pode injetar resumeState); forbidden em NEW→DISCONNECTED + forbidden_403; loggedOut apaga credenciais; timeout de pairing→500 (lacuna na 3.4). Entrypoint de boot do worker fica para T16. · Orquestrador
- 2026-09-24 · equipe · Maestri fechou ~01:37; agentes reiniciados vazios; T05 re-despachado sem perda. · Orquestrador
- 2026-09-24 · infra · Humano autorizou instalar dependências. Instalados nativos: PostgreSQL 16.4, Redis 8.10, docker CLI + compose v5 (sem daemon). verify.mjs usa infra local quando não há Docker daemon (spec/INFRA.md). T16 AC-T16-01 fica BLOCKED sem Docker. · Orquestrador
- 2026-09-24 · equipe · Nova equipe (a anterior não estava conectada): Operários Brasa, Cinzel, Malho; Testers Prisma, Radar. Docs de libs via context7. · Orquestrador
- 2026-09-24 · todas · Máquina sem Docker/Postgres/Redis/WSL. pnpm 9.15.9 instalado via npm -g. Infra de teste pendente de decisão do humano. · orquestrador-pai
- 2026-09-24 · equipe · Operários: Forja, Bigorna, Torno. Testers: Lupa, Sonda. Commits feitos só pelo orquestrador. · orquestrador-pai

## Escalonamentos ao humano

<!-- Data · Tarefa · Motivo · Relatório (spec/reports/...) -->
