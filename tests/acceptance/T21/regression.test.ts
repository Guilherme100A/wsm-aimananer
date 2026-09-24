// AC-T21-07 sem regressão: build passa; todos os data-testid anteriores continuam nas mesmas telas; o painel só chama
// as rotas de API que já chamava; nenhum request sai da origem; nenhum texto promete segurança contra ban (SPEC 1.4 nº 6).
// As suítes T12, T18 e T19 rodam sem edição (verify por tarefa) e completam este critério.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tail } from '../helpers/exec'
import { allowed, buildDashboard, DIST, doLogin, go, NAV_LINKS, openPage, seedSession, tid, tour, useDashboard, visit } from './shared'

const SCREENS: Record<string, string[]> = {
  home: ['page-home', 'card-connected', 'card-disconnected', 'card-warming', 'card-risk', 'card-sent', 'card-received', 'card-failed', 'card-last-event', 'card-value'],
  sessions: ['page-sessions', 'add-session', 'session-row', 'session-state', 'session-link', 'session-proxy'],
  'new-session': [
    'page-new-session',
    'new-direct-connection', // T22 (os new-proxy-* seguem no DOM, ocultos enquanto marcada)
    'new-name',
    'new-phone',
    'new-note',
    'new-proxy-protocol',
    'new-proxy-host',
    'new-proxy-port',
    'new-proxy-username',
    'new-proxy-password',
    'gen-qr',
    'gen-pairing',
  ],
  session: [
    'page-session',
    'session-card',
    'detail-connected',
    'detail-warmup',
    'detail-health',
    'detail-sent',
    'detail-received',
    'detail-failed',
    'detail-disconnects',
    'btn-pause',
    'btn-restart',
    'btn-logs',
    'btn-logout',
    'chart-messages-hour',
    'chart-messages-day',
    'chart-received-sent',
    'chart-failures',
    'chart-disconnects',
    'chart-latency',
    'chart-state',
    'session-proxy-panel',
    'detail-proxy',
    'session-proxy',
    'proxy-edit',
  ],
  contacts: ['page-contacts', 'csv-file', 'csv-text', 'csv-import'],
  groups: ['page-groups', 'groups-session', 'groups-refresh'],
  alerts: ['page-alerts', 'webhook-name', 'webhook-channel', 'webhook-url', 'webhook-secret', 'webhook-save'],
  ai: ['page-ai', 'ai-key', 'ai-key-status', 'ai-model-small', 'ai-model-large', 'ai-threshold', 'ai-max-tokens', 'ai-timeout', 'ai-enabled', 'ai-save', 'ai-test'],
}

const missingIn = (page: any, ids: string[]): Promise<string[]> =>
  page.evaluate((list: string[]) => list.filter((id) => !document.querySelector(`[data-testid="${id}"]`)), ids)

function filesOf(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? filesOf(p) : [p]
  })
}

describe('T21 — sem regressão', () => {
  const ctx = useDashboard()

  it('AC-T21-07 pnpm --filter @wsm/dashboard build passa', () => {
    const r = buildDashboard()
    expect(r.code, tail(r, 60)).toBe(0)
  })

  it('AC-T21-07 todos os data-testid anteriores continuam nas mesmas telas', async () => {
    const s = await seedSession(ctx)
    const page = await openPage(ctx, { login: false })
    await go(ctx, page, '/login')
    await page.locator(tid('login-username')).waitFor({ state: 'visible' })
    expect(await missingIn(page, ['login-username', 'login-password', 'login-submit']), 'login').toEqual([])
    await doLogin(ctx, page)

    for (const stop of tour(s.id)) {
      await visit(ctx, page, stop)
      if (stop.name === 'ai') await page.locator(tid('ai-key-status')).waitFor({ state: 'attached' })
      if (stop.name === 'sessions') await page.locator(tid('session-row')).first().waitFor({ state: 'attached' })
      const missing = await missingIn(page, [...SCREENS[stop.name], ...NAV_LINKS, 'nav-logout'])
      expect(missing, `testids ausentes em ${stop.name}`).toEqual([])
      if (stop.name === 'ai') expect(await page.locator('[data-testid^="ai-source-"]').count(), 'ai-source-*').toBeGreaterThan(0)
    }

    // interações do detalhe: Logs e edição do proxy
    await go(ctx, page, `/sessions/${s.id}`)
    await page.locator(tid('btn-logs')).click()
    await page.locator(tid('logs-panel')).waitFor({ state: 'attached' })
    await page.locator(tid('proxy-edit')).click()
    await page.locator(tid('proxy-save')).waitFor({ state: 'attached' })
    const edit = await missingIn(page, ['edit-proxy-protocol', 'edit-proxy-host', 'edit-proxy-port', 'edit-proxy-username', 'edit-proxy-password', 'proxy-save', 'proxy-cancel'])
    expect(edit, 'testids da edição do proxy').toEqual([])
    expect(ctx.pageErrors, 'erros de página').toEqual([])
  })

  it('AC-T21-07 o tour pelo painel só chama rotas de API que já existiam e nenhum request sai da origem', async () => {
    const s = await seedSession(ctx)
    const page = await openPage(ctx, { login: false })
    const origin = new URL(ctx.base).origin
    const external: string[] = []
    const apiCalls: string[] = []
    page.on('request', (req: any) => {
      const u = new URL(req.url())
      if (u.protocol === 'data:' || u.protocol === 'blob:') return
      if (u.origin !== origin) external.push(req.url())
      else if (/^\/(api|metrics)(\/|$)/.test(u.pathname)) apiCalls.push(`${req.method()} ${u.pathname}`)
    })
    await doLogin(ctx, page)
    for (const stop of tour(s.id)) await visit(ctx, page, stop)
    await page.locator(tid('nav-logout')).first().click()
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/login/)
    // tema escuro e login também sem requests externos (fontes, ícones)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.locator(tid('login-username')).waitFor({ state: 'visible' })
    await page.waitForLoadState('networkidle').catch(() => {})

    expect(external, 'requests fora da origem do painel').toEqual([])
    const unknown = [...new Set(apiCalls)].filter((c) => {
      const [m, p] = c.split(' ')
      return !allowed(m, p)
    })
    expect(unknown, 'chamadas de API novas/alteradas').toEqual([])
    expect(apiCalls.length).toBeGreaterThan(0)
  })

  it('AC-T21-07 o build não contém promessas de segurança contra ban (SPEC 1.4 nº 6)', () => {
    const forbidden = /seguro contra ban|imune a ban|ban-proof|anti-ban garantido|à prova de ban|a prova de ban|antiban garantido/i
    const hits = filesOf(DIST)
      .filter((f) => /\.(html|js|css|svg|json|txt)$/.test(f))
      .filter((f) => forbidden.test(readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })
})
