# Login do painel e proxy na sessão (T17)

## Login de administrador

| Variável | Default | Uso |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Usuário do painel |
| `ADMIN_PASSWORD` | `nimda` | Senha do painel. **Defina em produção**: sem ela, o boot loga um warn |
| `AUTH_SECRET` | aleatório por processo | Chave HMAC-SHA256 dos tokens de login (16+ caracteres). Sem ela, o boot loga um warn e os tokens caem a cada restart |
| `AUTH_SESSION_TTL_MS` | `43200000` (12 h) | Validade do token de login |

- `POST /api/auth/login {username, password}` é público. Credenciais certas devolvem
  `200 { token, expiresAt, user: { username, role: 'admin' } }`. Credenciais erradas devolvem `401 UNAUTHORIZED`
  com a mesma mensagem para usuário ou senha errados; a comparação é em tempo constante.
- **Limite:** 5 falhas em 15 min pelo mesmo IP fazem a tentativa seguinte (mesmo com a senha certa) devolver
  `429 RATE_LIMIT` até a janela passar.
- **IP considerado no limite (`TRUST_PROXY`):**
  - `TRUST_PROXY=false` (default): vale só o IP da conexão TCP, e o header `X-Forwarded-For` é **ignorado**.
    O cliente controla esse header; se ele fosse aceito, bastaria trocar o valor a cada tentativa para nunca
    levar 429.
  - `TRUST_PROXY=true`: use só quando a API estiver atrás de um proxy reverso que **sobrescreve** o header e
    não for acessível diretamente. O modelo é de **um salto de proxy confiável**: vale o valor **mais à
    direita** de `X-Forwarded-For`, que é o que esse proxy escreveu; nunca o primeiro. Se um proxy anexar em vez
    de sobrescrever, tudo à esquerda veio do cliente. Por exemplo, em `"<lixo do atacante>, <ip-real>"` conta o
    `ip-real`.
  - No `docker-compose.yml`, a API roda com `TRUST_PROXY=true`, e o nginx do dashboard envia
    `proxy_set_header X-Forwarded-For $remote_addr;`, sobrescrevendo em vez de anexar.
  - No compose, a porta da API (`API_HOST_PORT`) é publicada **só em `127.0.0.1`**, junto com postgres, redis
    e o worker (ver `docs/operations.md`). Da rede, só o dashboard (nginx) alcança a API, então o header que
    chega é sempre o escrito pelo nginx. Quem tem shell no próprio host ainda consegue chamar a API direto; se
    isso importar no seu ambiente, use `TRUST_PROXY=false`.
- **Auditoria:** toda tentativa grava `audit_logs` com `action = 'auth.login'` e
  `detail { username, success, ip }`. A senha nunca é registrada.
- **Token:** `wsm1.<payload>.<assinatura>`, opaco para o cliente. Payload com usuário, emissão, expiração e id,
  assinado com HMAC-SHA256(`AUTH_SECRET`).
- `/api/*` aceita `Authorization: Bearer <token de login>` **ou** `Bearer <API_TOKEN>`. O `API_TOKEN` continua
  valendo para integrações.
- `GET /api/auth/me` devolve `{ user, expiresAt }`. Com `API_TOKEN`, devolve
  `{ user: { username: 'api_token', role: 'integration' }, expiresAt: null }`.
- `POST /api/auth/logout` responde `204` e revoga o token até a expiração dele. A revogação fica em memória do
  processo da API: um restart da API esquece revogações, mas com `AUTH_SECRET` fixo os tokens ainda não
  expirados voltam a valer. Para derrubar todas as sessões, troque o `AUTH_SECRET`.

## Proxy dentro da sessão

O proxy é informado junto com o número; a página Proxies deixa de ser o caminho principal.

- `POST /api/sessions { name, phone, note?, proxy?: { protocol: 'http'|'https'|'socks5', host, port, username?, password? } }`:
  o proxy é criado (senha cifrada com `CREDENTIALS_KEY`, T06) e vinculado **na mesma transação** da sessão.
  Proxy inválido devolve 400 e nada é gravado. `proxy` junto com `proxyId` também devolve 400.
- `PATCH /api/sessions/:id { name?, note?, proxy?: {…} | null }` edita a sessão:
  - trocar ou remover o proxy marca `requires_restart`, gera auditoria (`session.update`) e apaga o proxy antigo;
  - no `proxy`, `password` **ausente mantém** a senha atual, `null` remove e texto troca;
  - proxy idêntico ao atual não conta como troca.
- As respostas de sessão trazem `proxy: { id, protocol, host, port, username, hasPassword } | null`, nunca a senha.
- A conexão continua só pelo proxy da sessão, sem fallback para conexão direta (T06). A troca só vale após
  `POST /api/sessions/:id/restart`.
- As rotas `/api/proxies` continuam funcionando, por compatibilidade.
