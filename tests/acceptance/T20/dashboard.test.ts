// AC-T20-06: botão "Adicionar número" na página Grupos. Harness do T12 (dashboard buildado servido na mesma
// origem da API em processo, chromium headless; um browser neste arquivo, fechado no afterAll do harness).
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { connectedSession, createSession, go, tid, useDashboard } from '../T12/shared'

const newGroupId = () => `1203630${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}@g.us`

describe('T20 — dashboard: Adicionar número (Grupos)', () => {
  const ctx = useDashboard()

  async function openGroups(sessionId: string) {
    const page = await ctx.newPage()
    await go(ctx, page, '/groups')
    await page.locator(tid('page-groups')).waitFor({ state: 'visible' })
    const select = page.locator(tid('groups-session'))
    await expect.poll(() => select.locator(`option[value="${sessionId}"]`).count(), { timeout: 15_000 }).toBe(1)
    await select.selectOption(sessionId)
    return page
  }

  async function setup(opts: { isAdmin?: boolean; members?: string[] } = {}) {
    const admin = await connectedSession(ctx)
    const groupId = newGroupId()
    const groupName = `Grupo ${randomBytes(2).toString('hex')}`
    admin.transport.setGroups([{ id: groupId, name: groupName, participants: 3, announce: false, isAdmin: opts.isAdmin ?? true, members: opts.members ?? [] }])
    const target = await createSession(ctx, { name: `Alvo ${randomBytes(2).toString('hex')}` })
    return { admin, groupId, groupName, target: target as { id: string; name: string; phone: string } }
  }

  const rowOf = (page: any, groupName: string) => page.locator(tid('group-row')).filter({ hasText: groupName })

  /** Abre o diálogo, escolhe o alvo, avança para a confirmação e devolve o texto dela. */
  async function chooseAndConfirmStep(page: any, groupName: string, targetId: string) {
    const row = rowOf(page, groupName)
    await row.waitFor({ state: 'visible', timeout: 15_000 })
    await row.locator(tid('group-add-number')).click()
    await page.locator(tid('group-add-dialog')).waitFor({ state: 'visible' })
    await page.locator(tid('group-add-target')).selectOption(targetId)
    await page.locator(tid('group-add-confirm-step')).click()
    await page.locator(tid('group-add-confirm-text')).waitFor({ state: 'visible' })
    return ((await page.locator(tid('group-add-confirm-text')).textContent()) ?? '').trim()
  }

  const resultOf = async (page: any) => {
    const el = page.locator(tid('group-add-result'))
    return { text: ((await el.textContent()) ?? '').trim(), result: await el.getAttribute('data-result') }
  }

  it('AC-T20-06 grupo em que a sessão é admin mostra o botão "Adicionar número" habilitado; sem admin, desabilitado com dica', async () => {
    const admin = await connectedSession(ctx)
    const adminGroup = `Admin ${randomBytes(2).toString('hex')}`
    const memberGroup = `Membro ${randomBytes(2).toString('hex')}`
    admin.transport.setGroups([
      { id: newGroupId(), name: adminGroup, participants: 3, announce: false, isAdmin: true, members: [] },
      { id: newGroupId(), name: memberGroup, participants: 8, announce: false, isAdmin: false, members: [] },
    ])
    const page = await openGroups(admin.id)
    const ok = rowOf(page, adminGroup).locator(tid('group-add-number'))
    await ok.waitFor({ state: 'visible', timeout: 15_000 })
    expect(((await ok.textContent()) ?? '').trim()).toBe('Adicionar número')
    expect(await ok.isEnabled()).toBe(true)

    const blocked = rowOf(page, memberGroup).locator(tid('group-add-number'))
    expect(await blocked.isDisabled(), 'sem admin o botão fica desabilitado').toBe(true)
    const hintEl = rowOf(page, memberGroup).locator(tid('group-add-hint'))
    const hint = `${(await blocked.getAttribute('title')) ?? ''} ${(await hintEl.count()) ? ((await hintEl.first().textContent()) ?? '') : ''}`
    expect(hint, 'dica explicando por que está desabilitado').toMatch(/admin/i)
  })

  it('AC-T20-06 diálogo escolhe UMA sessão do sistema (sem a própria), pede confirmação "Adicionar <nome/número> ao grupo <grupo>?" e mostra "adicionado"', async () => {
    const { admin, groupId, groupName, target } = await setup()
    const page = await openGroups(admin.id)
    const row = rowOf(page, groupName)
    await row.waitFor({ state: 'visible', timeout: 15_000 })
    await row.locator(tid('group-add-number')).click()
    await page.locator(tid('group-add-dialog')).waitFor({ state: 'visible' })
    const select = page.locator(tid('group-add-target'))
    expect(await select.evaluate((el: HTMLSelectElement) => el.multiple), 'escolha de UMA sessão').toBe(false)
    const values = await select.locator('option').evaluateAll((opts: HTMLOptionElement[]) => opts.map((o) => o.value))
    expect(values).toContain(target.id)
    expect(values, 'a própria sessão não pode ser alvo').not.toContain(admin.id)

    await select.selectOption(target.id)
    await page.locator(tid('group-add-confirm-step')).click()
    const confirmText = ((await page.locator(tid('group-add-confirm-text')).textContent()) ?? '').trim()
    expect(confirmText).toMatch(/^Adicionar .+ ao grupo .+\?$/)
    expect(confirmText.includes(target.name) || confirmText.includes(target.phone), confirmText).toBe(true)
    expect(confirmText).toContain(groupName)
    expect(admin.transport.groupAdds, 'nada acontece antes de confirmar').toEqual([])

    await page.locator(tid('group-add-confirm')).click()
    await expect.poll(async () => (await resultOf(page)).result, { timeout: 15_000 }).toBe('added')
    expect((await resultOf(page)).text).toMatch(/adicionado/i)
    expect(admin.transport.groupAdds).toHaveLength(1)
    expect(admin.transport.groupAdds[0].groupId).toBe(groupId)
  })

  it('AC-T20-06 cancelar a confirmação não adiciona nada', async () => {
    const { admin, groupName, target } = await setup()
    const page = await openGroups(admin.id)
    await chooseAndConfirmStep(page, groupName, target.id)
    await page.locator(tid('group-add-cancel')).click()
    await page.waitForTimeout(300)
    expect(admin.transport.groupAdds).toEqual([])
  })

  it('AC-T20-06 resultado "já é membro" aparece na tela', async () => {
    const pre = await createSession(ctx, { name: `Membro ${randomBytes(2).toString('hex')}` })
    const jid = `${String((pre as any).phone).replace(/^\+/, '')}@s.whatsapp.net`
    const { admin, groupName } = await setup({ members: [jid] })
    const page = await openGroups(admin.id)
    await chooseAndConfirmStep(page, groupName, (pre as any).id)
    await page.locator(tid('group-add-confirm')).click()
    await expect.poll(async () => (await resultOf(page)).result, { timeout: 15_000 }).toBe('already_member')
    expect((await resultOf(page)).text).toMatch(/já é membro/i)
  })

  it('AC-T20-06 resultado "não é admin" aparece quando o WhatsApp tirou o admin antes de confirmar', async () => {
    const { admin, groupId, groupName, target } = await setup()
    const page = await openGroups(admin.id)
    await chooseAndConfirmStep(page, groupName, target.id)
    admin.transport.setGroups([{ id: groupId, name: groupName, participants: 3, announce: false, isAdmin: false, members: [] }])
    await page.locator(tid('group-add-confirm')).click()
    await expect.poll(async () => (await resultOf(page)).result, { timeout: 15_000 }).toBe('not_admin')
    expect((await resultOf(page)).text).toMatch(/não é admin/i)
    expect(admin.transport.groupAdds).toEqual([])
  })

  it('AC-T20-06 segunda adição no mesmo minuto mostra o limite de 1 por minuto', async () => {
    const { admin, groupName, target } = await setup()
    const second = await createSession(ctx, { name: `Outro ${randomBytes(2).toString('hex')}` })
    const page = await openGroups(admin.id)
    await chooseAndConfirmStep(page, groupName, target.id)
    await page.locator(tid('group-add-confirm')).click()
    await expect.poll(async () => (await resultOf(page)).result, { timeout: 15_000 }).toBe('added')

    await chooseAndConfirmStep(page, groupName, (second as any).id)
    await page.locator(tid('group-add-confirm')).click()
    await expect.poll(async () => (await resultOf(page)).text, { timeout: 15_000 }).toMatch(/limite/i)
    expect(admin.transport.groupAdds, 'o limite barra no servidor: nada chega ao transporte').toHaveLength(1)
  })
})
