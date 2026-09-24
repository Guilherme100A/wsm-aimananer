# INFRA (atualizado 2026-09-24: Docker instalado)

> **Atual:** o humano instalou o Docker Desktop (engine 29.8, WSL2, ~8 GB para a VM). O `verify.mjs` detecta o daemon e usa `docker compose up -d --wait postgres redis` (ou o compose completo com infra=full). As URLs continuam as mesmas: postgres://wsm:wsm@localhost:5432/wsm e redis://localhost:6379. O Postgres e o Redis nativos ficam **parados** para não disputar as portas; o modo local continua disponível com WSM_INFRA=local. O AC-T16-01 e o AC-T16-05 deixam de estar BLOQUEADOS.

## Histórico: infra local (sem Docker)

A máquina de desenvolvimento é Windows sem Docker daemon nem WSL. Para rodar os testes:

| Serviço | Onde | Conexão |
|---|---|---|
| PostgreSQL 16.4 (binários nativos) | `C:/Users/green/tools/pg` · dados em `C:/Users/green/tools/pgdata` | `postgres://wsm:wsm@localhost:5432/wsm` |
| Redis 8.10 (build nativo) | `C:/Users/green/tools/redis` | `redis://localhost:6379` |
| docker CLI + compose v5 (sem daemon) | no PATH | serve só para `docker compose config` |

- Usuário `wsm` é superusuário do Postgres: testes podem criar bancos descartáveis (`CREATE DATABASE wsm_test_<rand>`).
- Suba/verifique a infra com `node spec/verify/infra-local.mjs` (idempotente).
- `verify.mjs` com `WSM_INFRA=local` (default quando `docker info` falha) **não** roda `docker compose up`: só confere que as portas 5432 e 6379 respondem.
- Variáveis de ambiente para testes: `DATABASE_URL`, `REDIS_URL` com os valores acima (use-os como default nos helpers quando não definidos).
- AC-T16-01 (`docker compose up --wait`) não é executável nesta máquina: fica BLOCKED até haver Docker.
