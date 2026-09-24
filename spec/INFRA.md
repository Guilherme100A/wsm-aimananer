# INFRA local (decisão do Orquestrador, 2026-09-24)

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
