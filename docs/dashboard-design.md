# Dashboard — redesign "minimalista premium"

Pedido do humano (2026-09-24): estilo "minimalista premium", "SaaS moderno", "Apple-like",
"Linear/Vercel inspired", "gaming clean". Escopo: `apps/dashboard/**` (+ este doc).

## Direção escolhida

Uma única linguagem visual que cobre os adjetivos pedidos: **Linear/Vercel** como base
(superfícies escuras em camadas, bordas de 1px, tipografia compacta), acabamento **Apple-like**
(cantos arredondados, espaçamento generoso, movimento discreto) e um toque **gaming clean**
(acento vívido e brilho sutil no foco, sem neon nem ruído).

- **Temas escuro e claro completos.** Sem escolha salva, segue `prefers-color-scheme`; o botão
  `theme-toggle` alterna e grava a escolha; a escolha fica em `localStorage["wsm.theme"]` (só preferência visual; o token continua
  só em memória/sessionStorage, AC-T18-01). Aplicado em `<html data-theme="dark|light">`.
- **Tokens** em `:root` (cores, raios, sombras, espaçamento, tipografia). Nenhuma cor solta nos
  componentes; os gráficos (recharts) leem as cores dos tokens.
- **Tipografia:** pilha de sistema (Inter/SF Pro/Segoe UI Variable), números tabulares em cards e
  tabelas. **Nenhum recurso externo** (sem Google Fonts/CDN): o painel roda offline atrás do nginx.
- **Estado da sessão:** pílula com ponto colorido. O texto continua exatamente o da SPEC 3.2
  (ex.: `🟢 Connected`): o emoji fica num `<span aria-hidden>` desenhado como ponto via CSS, então o
  `textContent` não muda.
- **Navegação:** sidebar fixa com ícones SVG inline; abaixo de 768px vira barra superior com menu
  recolhível (`nav-toggle`). O item ativo tem `aria-current="page"`. Tabelas largas rolam dentro
  de si mesmas, nunca o documento. Botão de tema no rodapé da sidebar.
- **Movimento:** transições de 120–200 ms; `prefers-reduced-motion` desliga tudo.
- **Acessibilidade:** foco visível em todo controle; contraste AA (texto ≥ 4.5:1) nos dois temas.

## Invariantes (não negociáveis)

1. Todos os `data-testid` existentes continuam no DOM com o mesmo significado (inclusive os
   dinâmicos: `card-*`, `chart-*`, `<prefixo>-proxy-*`, `ai-source-*`).
2. Textos exatos usados pelas suítes: títulos `Contatos`, `Grupos`, `Alertas / Webhooks`,
   `IA / Modelo LLM`; botões `+ Adicionar número`, `Gerar QR Code`, `Gerar Pairing Code`,
   `Pause`, `Restart`, `Logs`; rótulos Nome, Número, Proxy, Protocolo, IP/Host, Porta, Usuário,
   Senha, Observação; rótulos do card da sessão; indicadores da SPEC 3.2; `—` sem último evento.
3. Nenhuma chamada de API muda (mesmos endpoints, métodos e bodies).
4. `pages/Groups*` não é editado até o T20 ser commitado (recebe o visual novo só pelo CSS global).
5. Regra 1.4 nº 6: nenhuma promessa de segurança contra ban em texto de UI.

## Fases

- **Fase 1:** tokens + tema, CSS global, Layout (sidebar/topbar, tema), primitivas de `ui.tsx`
  (Card, StateIndicator, ChartBox, ErrorText), Login, Home, Sessões, Adicionar número, Detalhe
  (gráficos com tokens), Contatos, Alertas, IA. Grupos só via CSS global.
- **Fase 2 (após o commit do T20):** página Grupos (diálogo "Adicionar número" do T20 no mesmo
  visual) e ajustes finais.

## Novos `data-testid` (aditivos)

| testid | onde | significado |
|---|---|---|
| `theme-toggle` | sidebar/topbar | alterna claro/escuro |
| `nav-toggle` | topbar (< 768px) | abre/fecha a navegação |
| `app-nav` | `<nav>` | contêiner da navegação |

## Tokens (AC-T21-01)

`--bg`, `--surface`, `--surface-2`, `--text`, `--text-muted`, `--border`, `--accent`, `--accent-fg`,
`--success`, `--warning`, `--danger`, `--radius`, `--radius-sm`, `--shadow`, `--font-sans`
(mais tokens auxiliares). `body { background: var(--bg) }`.

## Critérios de aceitação (T21, ID provisório; testes da Íris)

Combinados com a Íris em 2026-09-24.

- **AC-T21-01** Os tokens acima estão definidos e não vazios; o fundo do body usa `--bg`.
- **AC-T21-02** Temas claro e escuro via `html[data-theme]`. Sem escolha salva, segue
  `prefers-color-scheme`. `theme-toggle` alterna e grava `localStorage['wsm.theme']`, a única chave
  no localStorage (o token nunca vai para lá).
- **AC-T21-03** Contraste AA ≥ 4.5:1 nos dois temas: texto do body, links do nav, `card-value`,
  texto do botão primário e texto muted.
- **AC-T21-04** Foco visível (`outline`/`box-shadow`) em button, input e link do nav. Com
  `prefers-reduced-motion: reduce`, nenhuma transição ou animação passa de 0.01 s.
- **AC-T21-05** Sem scroll horizontal em 390×844 e 1440×900 em todas as páginas (inclusive Grupos e
  Login). Em 390, a navegação fica alcançável via `nav-toggle`. O item ativo tem `aria-current="page"`.
- **AC-T21-06** Cards e painéis com raio ≥ 8px e borda ou sombra. O indicador de estado é uma pílula
  com cor distinta por estado. Os gráficos não usam as cores padrão do recharts.
- **AC-T21-07** Sem regressão: data-testids, chamadas `/api` e origem inalterados. Nenhum texto
  anti-ban no `dist`. O build passa. T12, T18 e T19 ficam verdes sem editar os testes.
