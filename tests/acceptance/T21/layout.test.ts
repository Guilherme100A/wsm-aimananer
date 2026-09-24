// AC-T21-04 foco visível e prefers-reduced-motion; AC-T21-05 responsivo (sem scroll horizontal, nav alcançável,
// aria-current); AC-T21-06 acabamento (cantos/bordas, pílula de estado com cor por estado, gráficos sem cores padrão).
import { describe, expect, it } from 'vitest'
import {
  createSession,
  DESKTOP,
  ensureNavOpen,
  go,
  hashOf,
  INDICATORS,
  insertMessages,
  MOBILE,
  NAV_LINKS,
  openPage,
  seedSession,
  setStatus,
  tid,
  tour,
  useDashboard,
  visit,
} from './shared'

/** Estilo de foco do elemento ativo. */
const focusInfo = (page: any) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return null
    const cs = getComputedStyle(el)
    return {
      tag: el.tagName.toLowerCase(),
      type: (el as HTMLInputElement).type ?? '',
      testid: el.getAttribute('data-testid'),
      outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
      shadow: cs.boxShadow !== 'none' && cs.boxShadow !== '',
      desc: `${cs.outlineStyle} ${cs.outlineWidth} / ${cs.boxShadow}`,
    }
  })

const toSeconds = (list: string) =>
  list
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (v.endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v)))

describe('T21 — acessibilidade, responsivo e acabamento', () => {
  const ctx = useDashboard()

  it('AC-T21-04 foco por teclado (Tab) é visível em links do nav, botões e campos', async () => {
    for (const [hash, ready] of [
      ['/', 'page-home'],
      ['/sessions/new', 'page-new-session'],
    ] as const) {
      const page = await openPage(ctx)
      await go(ctx, page, hash)
      await page.locator(tid(ready)).waitFor({ state: 'attached' })
      await page.waitForLoadState('networkidle').catch(() => {})
      const seen = new Set<string>()
      const bad: string[] = []
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab')
        const f = await focusInfo(page)
        if (!f) continue
        const kind = f.tag === 'a' ? 'a' : f.tag === 'button' ? 'button' : ['input', 'select', 'textarea'].includes(f.tag) ? 'field' : f.tag
        seen.add(kind)
        if (!f.outline && !f.shadow) bad.push(`${hash} <${f.tag} ${f.type}> [${f.testid}] foco: ${f.desc}`)
      }
      expect(bad, bad.join('\n')).toEqual([])
      expect(seen.has('a'), `${hash}: nenhum link alcançado por Tab`).toBe(true)
      expect(seen.has('button'), `${hash}: nenhum botão alcançado por Tab`).toBe(true)
      if (hash === '/sessions/new') expect(seen.has('field'), 'nenhum campo alcançado por Tab').toBe(true)
    }
  })

  it('AC-T21-04 com prefers-reduced-motion: reduce nenhuma transição ou animação passa de 0,01 s', async () => {
    const s = await seedSession(ctx)
    const page = await openPage(ctx, { reducedMotion: 'reduce' })
    const bad: string[] = []
    for (const stop of tour(s.id)) {
      await visit(ctx, page, stop)
      const found: Array<{ testid: string | null; tag: string; t: string; a: string }> = await page.evaluate(() =>
        Array.from(document.querySelectorAll('*')).map((el) => {
          const cs = getComputedStyle(el)
          return { testid: el.closest('[data-testid]')?.getAttribute('data-testid') ?? null, tag: el.tagName.toLowerCase(), t: cs.transitionDuration, a: cs.animationName === 'none' ? '0s' : cs.animationDuration }
        }),
      )
      for (const f of found) {
        const max = Math.max(0, ...toSeconds(f.t), ...toSeconds(f.a))
        if (max > 0.01) bad.push(`${stop.name}: <${f.tag}> [${f.testid}] transition=${f.t} animation=${f.a}`)
      }
    }
    expect(bad, bad.slice(0, 20).join('\n')).toEqual([])
  })

  it('AC-T21-05 nenhuma tela tem scroll horizontal no documento em 390 px e em 1440 px', async () => {
    const s = await seedSession(ctx)
    const bad: string[] = []
    for (const vp of [MOBILE, DESKTOP]) {
      const page = await openPage(ctx, vp)
      for (const stop of tour(s.id)) {
        await visit(ctx, page, stop)
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, w: window.innerWidth }))
        if (Math.max(m.sw, m.bw) > m.w + 1) bad.push(`${vp.width}px ${stop.name}: scrollWidth=${Math.max(m.sw, m.bw)} > ${m.w}`)
      }
      const login = await openPage(ctx, { ...vp, login: false })
      await go(ctx, login, '/login')
      await login.locator(tid('login-username')).waitFor({ state: 'visible' })
      const m = await login.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }))
      if (m.sw > m.w + 1) bad.push(`${vp.width}px login: scrollWidth=${m.sw} > ${m.w}`)
    }
    expect(bad, bad.join('\n')).toEqual([])
  })

  it('AC-T21-05 em 1440 px os links nav-* ficam sempre visíveis e o nav-toggle fica oculto', async () => {
    const page = await openPage(ctx, DESKTOP)
    await go(ctx, page, '/')
    await page.locator(tid('page-home')).waitFor({ state: 'attached' })
    for (const id of [...NAV_LINKS, 'nav-logout', 'theme-toggle']) expect(await page.locator(tid(id)).first().isVisible(), `${id} visível em 1440`).toBe(true)
    const toggle = page.locator(tid('nav-toggle'))
    if ((await toggle.count()) > 0) expect(await toggle.first().isVisible(), 'nav-toggle deveria ficar oculto em 1440').toBe(false)
  })

  it('AC-T21-05 em 390 px a navegação é alcançável (direto ou pelo nav-toggle) e leva às páginas', async () => {
    const page = await openPage(ctx, MOBILE)
    const targets: Array<[string, string, RegExp]> = [
      ['nav-contacts', 'page-contacts', /^#\/contacts/],
      ['nav-alerts', 'page-alerts', /^#\/alerts/],
      ['nav-ai', 'page-ai', /^#\/ai/],
      ['nav-sessions', 'page-sessions', /^#\/sessions/],
    ]
    for (const [nav, pageId, hash] of targets) {
      await ensureNavOpen(page)
      await page.locator(tid(nav)).first().click()
      await expect.poll(() => hashOf(page)).toMatch(hash)
      await page.locator(tid(pageId)).waitFor({ state: 'visible' })
    }
    await ensureNavOpen(page)
    expect(await page.locator(tid('nav-logout')).first().isVisible(), 'Sair alcançável no celular').toBe(true)
  })

  it('AC-T21-05 o item ativo do nav tem aria-current="page" (e só ele)', async () => {
    const s = await seedSession(ctx)
    const page = await openPage(ctx, DESKTOP)
    const expected: Record<string, string> = {
      home: 'nav-home',
      sessions: 'nav-sessions',
      'new-session': 'nav-sessions',
      session: 'nav-sessions',
      contacts: 'nav-contacts',
      groups: 'nav-groups',
      alerts: 'nav-alerts',
      ai: 'nav-ai',
    }
    for (const stop of tour(s.id)) {
      await visit(ctx, page, stop)
      const current: string[] = await page.evaluate(
        (ids: string[]) => ids.filter((id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-current') === 'page'),
        NAV_LINKS,
      )
      expect(current, `aria-current em ${stop.name}`).toEqual([expected[stop.name]])
    }
  })

  it('AC-T21-06 cards, card da sessão, painéis e gráficos têm cantos ≥ 8 px e borda ou sombra', async () => {
    const s = await seedSession(ctx)
    const page = await openPage(ctx)
    const check = async (id: string) => {
      const r = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const cs = getComputedStyle(el)
        const border = ['Top', 'Right', 'Bottom', 'Left'].some(
          (k) => parseFloat((cs as any)[`border${k}Width`]) > 0 && (cs as any)[`border${k}Style`] !== 'none' && !/rgba\(.*,\s*0\)$/.test((cs as any)[`border${k}Color`]),
        )
        return { radius: parseFloat(cs.borderTopLeftRadius), border, shadow: cs.boxShadow !== 'none' }
      }, tid(id))
      expect(r, `${id} não encontrado`).not.toBeNull()
      expect(r!.radius, `${id}: border-radius`).toBeGreaterThanOrEqual(8)
      expect(r!.border || r!.shadow, `${id}: sem borda nem sombra`).toBe(true)
    }
    await go(ctx, page, '/')
    await page.locator(tid('card-connected')).waitFor({ state: 'visible' })
    for (const id of ['card-connected', 'card-sent', 'card-last-event']) await check(id)
    await go(ctx, page, `/sessions/${s.id}`)
    await page.locator(tid('session-card')).waitFor({ state: 'visible' })
    for (const id of ['session-card', 'session-proxy-panel', 'chart-messages-hour', 'chart-latency', 'chart-state']) await check(id)
  })

  it('AC-T21-06 o indicador de estado é uma pílula com o texto da SPEC 3.2 e cor distinta por estado', async () => {
    const ids: Record<string, string> = {}
    for (const st of ['STABLE', 'DEGRADED', 'PAUSED']) {
      const x = await createSession(ctx, { name: `t21-${st.toLowerCase()}-${Date.now()}` })
      setStatus(ctx, x.id, st)
      ids[st] = x.id
    }
    const page = await openPage(ctx)
    await go(ctx, page, '/sessions')
    const sig: Record<string, string> = {}
    for (const [st, id] of Object.entries(ids)) {
      const pill = page.locator(`[data-testid="session-row"][data-session-id="${id}"] ${tid('session-state')}`)
      await pill.waitFor({ state: 'visible' })
      expect(((await pill.textContent()) ?? '').trim()).toBe(INDICATORS[st])
      expect(await pill.getAttribute('data-state')).toBe(st)
      const info = await pill.evaluate((el: Element) => {
        const C = (window as any).__wsmColor
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        const kids = Array.from(el.querySelectorAll('*')).map((k) => {
          const kc = getComputedStyle(k)
          const b = getComputedStyle(k, '::before')
          return [kc.backgroundColor, kc.color, b.backgroundColor].join('|')
        })
        const before = getComputedStyle(el, '::before')
        return {
          radius: parseFloat(cs.borderTopLeftRadius),
          height: r.height,
          filled: C.rgba(cs.backgroundColor)[3] > 0 || parseFloat(cs.borderTopWidth) > 0,
          signature: [cs.backgroundColor, cs.color, cs.borderTopColor, before.backgroundColor, ...kids].join('/'),
        }
      })
      expect(info.radius, `${st}: pílula (radius ${info.radius} vs altura ${info.height})`).toBeGreaterThanOrEqual(info.height / 2 - 0.5)
      expect(info.filled, `${st}: pílula sem fundo nem borda`).toBe(true)
      sig[st] = info.signature
    }
    expect(new Set(Object.values(sig)).size, `cores por estado: ${JSON.stringify(sig)}`).toBe(3)
  })

  it('AC-T21-06 os gráficos do detalhe não usam as cores padrão do recharts', async () => {
    const s = await seedSession(ctx)
    insertMessages(ctx, s.id, 5, 'sent')
    insertMessages(ctx, s.id, 3, 'failed')
    insertMessages(ctx, s.id, 4, 'delivered', 'inbound')
    const page = await openPage(ctx)
    await go(ctx, page, `/sessions/${s.id}`)
    await page.locator(`${tid('chart-messages-hour')} svg`).first().waitFor({ state: 'attached' })
    await page.waitForTimeout(500)
    const html: string = (await page.locator('[data-testid^="chart-"]').evaluateAll((els: Element[]) => els.map((e) => e.innerHTML).join('\n'))).toLowerCase()
    expect(html, 'gráficos sem svg').toContain('<svg')
    for (const c of ['#8884d8', '#82ca9d', 'rgb(136, 132, 216)', 'rgb(130, 202, 157)']) expect(html, `cor padrão ${c} nos gráficos`).not.toContain(c)
  })
})
