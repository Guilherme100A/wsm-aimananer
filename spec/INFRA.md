# INFRA

> **Atualizado em 2026-09-24 — Docker Desktop instalado.**

O ambiente atual utiliza Docker Desktop com engine 29.8 e WSL2, com aproximadamente 8 GB destinados à VM.

O `verify.mjs` detecta o daemon Docker e utiliza:

```text
docker compose up -d --wait postgres redis
```

ou o compose completo quando `infra=full`.

## Conexões

As URLs utilizadas são:

```text
postgres://wsm:wsm@127.0.0.1:5432/wsm
redis://127.0.0.1:6379
```

O Postgres e Redis nativos ficam parados para evitar disputa pelas portas.

O modo de infraestrutura local continua disponível através de:

```text
WSM_INFRA=local
```

## Regra de endereço

**Use `127.0.0.1`, não `localhost`.**

As portas do compose ficam disponíveis apenas em IPv4 local. No Windows, `localhost` pode tentar `::1` primeiro, causando aproximadamente 2 segundos adicionais por conexão no libpq.

O `verify.mjs` já exporta `DATABASE_URL` e `REDIS_URL` utilizando `127.0.0.1`.

## Execução dos testes

Suba a infraestrutura Docker com:

```text
docker compose up -d --wait postgres redis
```

Depois execute as suítes individualmente:

```text
node spec/verify/verify.mjs <Tarefa> --role operario
node spec/verify/verify.mjs <Tarefa> --role tester
```

As suítes devem ser executadas **uma por vez**, principalmente as que utilizam Postgres, Redis ou compartilham build.

O `verify.mjs` já configura:

* `VITEST_MAX_WORKERS=4`;
* pnpm com um pacote por vez;
* `DATABASE_URL` utilizando `127.0.0.1`;
* `REDIS_URL` utilizando `127.0.0.1`.

As suítes de dashboard (T12, T18-T22) compartilham o build e devem ser executadas por um agente por vez.

## Infraestrutura local

O modo `WSM_INFRA=local` continua disponível para desenvolvimento e testes locais quando necessário.

Nesse modo, o projeto utiliza os serviços locais configurados pela máquina em vez do compose Docker.

## Estado dos ACs

Com o Docker Desktop disponível, os ACs que dependiam de Docker podem ser executados normalmente.

O AC-T16-01 e o AC-T16-05 **não estão mais bloqueados por infraestrutura**.
