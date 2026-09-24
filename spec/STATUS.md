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
| 3 | T05 | Session Manager | IN_PROGRESS | Brasa | Prisma | 0 | |
| 4 | T08 | Fila de mensagens | TODO | | | 0 | |
| 4 | T10 | Warm-up e Health Monitor | TODO | | | 0 | |
| 5 | T09 | Motor de segurança | TODO | | | 0 | |
| 5 | T11 | Alertas | TODO | | | 0 | |
| 5 | T14 | Grupos | TODO | | | 0 | |
| 6 | T13 | IA assistiva | TODO | | | 0 | |
| 6 | T15 | Observabilidade | TODO | | | 0 | |
| 6 | T12 | Dashboard | TODO | | | 0 | |
| 7 | T16 | Integração E2E | TODO | | | 0 | |

## Bloqueios e decisões

<!-- Data · Tarefa · Pergunta/decisão · Quem decidiu -->
- 2026-09-24 · infra · Humano autorizou instalar dependências. Instalados nativos: PostgreSQL 16.4, Redis 8.10, docker CLI + compose v5 (sem daemon). verify.mjs usa infra local quando não há Docker daemon (spec/INFRA.md). T16 AC-T16-01 fica BLOCKED sem Docker. · Orquestrador
- 2026-09-24 · equipe · Nova equipe (a anterior não estava conectada): Operários Brasa, Cinzel, Malho; Testers Prisma, Radar. Docs de libs via context7. · Orquestrador
- 2026-09-24 · todas · Máquina sem Docker/Postgres/Redis/WSL. pnpm 9.15.9 instalado via npm -g. Infra de teste pendente de decisão do humano. · orquestrador-pai
- 2026-09-24 · equipe · Operários: Forja, Bigorna, Torno. Testers: Lupa, Sonda. Commits feitos só pelo orquestrador. · orquestrador-pai

## Escalonamentos ao humano

<!-- Data · Tarefa · Motivo · Relatório (spec/reports/...) -->
