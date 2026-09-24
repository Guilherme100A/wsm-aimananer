// AC-T21-01 tokens de design em :root; AC-T21-02 temas claro/escuro (prefers-color-scheme + theme-toggle persistido em
// localStorage 'wsm.theme', sem token no localStorage); AC-T21-03 contraste WCAG AA nos dois temas.
import { describe, expect, it } from 'vitest'
import {
  bodyBg,
  colorDistance,
  contrastOf,
  go,
  MOBILE,
  NAV_LINKS,
  openPage,
  readTokens,
  seedSession,
  themeOf,
  tid,
  TOKENS,
  tour,
  useDashboard,
  visit,
} from './shared'

const lum = (c: number[]) => {
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}
const themes = ['light', 'dark'] as const

describe('T21 — tokens, tema e contraste', () => {
  const ctx = useDashboard()

  it('AC-T21-01 :root define todos os tokens de design, não vazios, nos dois temas', async () => {
    for (const scheme of themes) {
      const page = await openPage(ctx, { colorScheme: scheme })
      await go(ctx, page, '/')
      await page.locator(tid('page-home')).waitFor({ state: 'attached' })
      const t = await readTokens(page)
      const missing = TOKENS.filter((n) => !t[n])
      expect(missing, `tokens ausentes/vazios no tema ${scheme}: ${JSON.stringify(t)}`).toEqual([])
      expect(t['--radius'], '--radius deve ser um comprimento').toMatch(/\d/)
      expect(t['--radius-sm'], '--radius-sm deve ser um comprimento').toMatch(/\d/)
    }
  })

  it('AC-T21-01 o fundo do body usa o token --bg', async () => {
    for (const scheme of themes) {
      const page = await openPage(ctx, { colorScheme: scheme })
      await go(ctx, page, '/sessions')
      await page.locator(tid('page-sessions')).waitFor({ state: 'attached' })
      const [body, token] = await page.evaluate(() => {
        const C = (window as any).__wsmColor
        return [C.rgba(getComputedStyle(document.body).backgroundColor), C.rgba(C.resolveVar('--bg'))]
      })
      expect(token[3], `--bg precisa ser uma cor (${scheme})`).toBeGreaterThan(0)
      expect(colorDistance(body, token), `body ${body} ≠ --bg ${token} (${scheme})`).toBeLessThan(3)
    }
  })

  it('AC-T21-01 os tokens de cor mudam entre os temas', async () => {
    const values: Record<string, Record<string, string>> = {}
    for (const scheme of themes) {
      const page = await openPage(ctx, { colorScheme: scheme })
      await go(ctx, page, '/')
      await page.locator(tid('page-home')).waitFor({ state: 'attached' })
      values[scheme] = await page.evaluate(() => {
        const C = (window as any).__wsmColor
        return { bg: C.resolveVar('--bg'), text: C.resolveVar('--text', 'color'), surface: C.resolveVar('--surface') }
      })
    }
    expect(values.light.bg).not.toBe(values.dark.bg)
    expect(values.light.text).not.toBe(values.dark.text)
    expect(values.light.surface).not.toBe(values.dark.surface)
  })

  it('AC-T21-02 sem escolha salva, o tema segue prefers-color-scheme (html[data-theme]), inclusive no login', async () => {
    const bgs: Record<string, number[]> = {}
    for (const scheme of themes) {
      const page = await openPage(ctx, { colorScheme: scheme, login: false })
      await go(ctx, page, '/login')
      await page.locator(tid('login-username')).waitFor({ state: 'visible' })
      expect(await themeOf(page), `login com prefers-color-scheme=${scheme}`).toBe(scheme)
      const logged = await openPage(ctx, { colorScheme: scheme })
      await go(ctx, logged, '/')
      await logged.locator(tid('page-home')).waitFor({ state: 'attached' })
      expect(await themeOf(logged), `home com prefers-color-scheme=${scheme}`).toBe(scheme)
      bgs[scheme] = await bodyBg(logged)
    }
    expect(lum(bgs.dark), `fundo escuro ${bgs.dark} deveria ser mais escuro que o claro ${bgs.light}`).toBeLessThan(lum(bgs.light))
    expect(colorDistance(bgs.dark, bgs.light)).toBeGreaterThan(60)
  })

  it('AC-T21-02 theme-toggle alterna o tema, grava wsm.theme e a escolha vence prefers-color-scheme após reload', async () => {
    const page = await openPage(ctx, { colorScheme: 'light' })
    await go(ctx, page, '/')
    await page.locator(tid('page-home')).waitFor({ state: 'attached' })
    expect(await themeOf(page)).toBe('light')
    const before = await bodyBg(page)

    await page.locator(tid('theme-toggle')).first().click()
    await expect.poll(() => themeOf(page)).toBe('dark')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('wsm.theme'))).toBe('dark')
    await expect.poll(async () => colorDistance(await bodyBg(page), before), { message: 'fundo não mudou com o toggle' }).toBeGreaterThan(60)

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.locator(tid('page-home')).waitFor({ state: 'attached' })
    expect(await themeOf(page), 'escolha salva deve vencer o prefers-color-scheme=light').toBe('dark')

    await page.locator(tid('theme-toggle')).first().click()
    await expect.poll(() => themeOf(page)).toBe('light')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('wsm.theme'))).toBe('light')
  })

  it('AC-T21-02 o localStorage guarda só a preferência de tema; o token de login continua fora dele', async () => {
    const page = await openPage(ctx, { colorScheme: 'dark' })
    await go(ctx, page, '/')
    await page.locator(tid('page-home')).waitFor({ state: 'attached' })
    await page.locator(tid('theme-toggle')).first().click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('wsm.theme'))).toBe('light')
    const { keys, values, token } = await page.evaluate(() => ({
      keys: Object.keys(localStorage),
      values: Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? ''),
      token: sessionStorage.getItem('wsm.token'),
    }))
    expect(token, 'token de login em sessionStorage wsm.token').toBeTruthy()
    expect(keys).toEqual(['wsm.theme'])
    expect(values.join('\n')).not.toContain(token!)
  })

  it('AC-T21-02 o theme-toggle fica alcançável no celular (390 px)', async () => {
    const page = await openPage(ctx, { ...MOBILE, colorScheme: 'light' })
    await go(ctx, page, '/sessions')
    await page.locator(tid('page-sessions')).waitFor({ state: 'attached' })
    const toggle = page.locator(tid('theme-toggle')).first()
    if (!(await toggle.isVisible())) {
      await page.locator(tid('nav-toggle')).first().click()
      await toggle.waitFor({ state: 'visible' })
    }
    await toggle.click()
    await expect.poll(() => themeOf(page)).toBe('dark')
  })

  it('AC-T21-03 nav, card-value e botão primário têm contraste ≥ 4.5:1 nos dois temas', async () => {
    for (const scheme of themes) {
      const page = await openPage(ctx, { colorScheme: scheme })
      await go(ctx, page, '/')
      await page.locator(tid('page-home')).waitFor({ state: 'attached' })
      await page.waitForLoadState('networkidle').catch(() => {})
      for (const id of [...NAV_LINKS, 'nav-logout', 'card-value']) {
        const c = await contrastOf(page, tid(id))
        expect(c, `${id} não encontrado/visível (${scheme})`).not.toBeNull()
        expect(c!.ratio, `${id} (${scheme}) fg=${c!.fg} bg=${c!.bg}`).toBeGreaterThanOrEqual(4.5)
      }
      await go(ctx, page, '/sessions/new')
      await page.locator(tid('gen-qr')).waitFor({ state: 'visible' })
      const btn = await contrastOf(page, tid('gen-qr'))
      expect(btn!.ratio, `gen-qr (${scheme}) fg=${btn!.fg} bg=${btn!.bg}`).toBeGreaterThanOrEqual(4.5)

      const login = await openPage(ctx, { colorScheme: scheme, login: false })
      await go(ctx, login, '/login')
      await login.locator(tid('login-submit')).waitFor({ state: 'visible' })
      const ls = await contrastOf(login, tid('login-submit'))
      expect(ls!.ratio, `login-submit (${scheme}) fg=${ls!.fg} bg=${ls!.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('AC-T21-03 todo texto visível (inclusive o muted) atinge o contraste AA em todas as telas, nos dois temas', async () => {
    const s = await seedSession(ctx)
    const offenders: string[] = []
    for (const scheme of themes) {
      const page = await openPage(ctx, { colorScheme: scheme })
      for (const stop of tour(s.id)) {
        await visit(ctx, page, stop)
        const low = await page.evaluate(() => (window as any).__wsmColor.lowContrast(document.body))
        for (const o of low) offenders.push(`${scheme} ${stop.name}: <${o.tag}> [${o.testid}] "${o.text}" ${o.ratio} < ${o.min} fg=${o.fg} bg=${o.bg}`)
      }
      const login = await openPage(ctx, { colorScheme: scheme, login: false })
      await go(ctx, login, '/login')
      await login.locator(tid('login-username')).waitFor({ state: 'visible' })
      for (const o of await login.evaluate(() => (window as any).__wsmColor.lowContrast(document.body)))
        offenders.push(`${scheme} login: <${o.tag}> [${o.testid}] "${o.text}" ${o.ratio} < ${o.min} fg=${o.fg} bg=${o.bg}`)
    }
    expect(offenders, offenders.slice(0, 30).join('\n')).toEqual([])
  })
})
