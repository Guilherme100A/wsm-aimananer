import { describe, expect, it } from 'vitest'
import { canMessage, jidToE164, matchOptOutKeyword, normalizeText, parseOptOutKeywords } from './policy'
import { parseContactsCsv, parseCsv } from './csv'

describe('canMessage', () => {
  it.each([
    [null, { ok: false, reason: 'contact_not_found' }],
    [undefined, { ok: false, reason: 'contact_not_found' }],
    [{ consent: true, optOut: true }, { ok: false, reason: 'opt_out' }],
    [{ consent: false, optOut: true }, { ok: false, reason: 'opt_out' }],
    [{ consent: false, optOut: false }, { ok: false, reason: 'no_consent' }],
    [{ consent: true, optOut: false }, { ok: true }],
  ])('%j → %j', (contact, expected) => {
    expect(canMessage(contact)).toEqual(expected)
  })
})

describe('opt-out keywords', () => {
  it('normaliza acentos, caixa, pontuação e espaços', () => {
    expect(normalizeText('  Sáir!! ')).toBe('SAIR')
    expect(normalizeText('não, obrigado')).toBe('NAO OBRIGADO')
  })

  it.each(['SAIR', 'sair', ' Sair. ', 'parar!', 'Stop', 'cancelar 🙏', 'CÂNCELAR'])('%j é opt-out', (text) => {
    expect(matchOptOutKeyword(text)).toBeDefined()
  })

  it.each(['quero sair daqui', 'stopp', 'oi', '', undefined, '!!!'])('%j não é opt-out', (text) => {
    expect(matchOptOutKeyword(text)).toBeUndefined()
  })

  it('lista configurável', () => {
    expect(matchOptOutKeyword('descadastrar', ['DESCADASTRAR'])).toBe('DESCADASTRAR')
    expect(matchOptOutKeyword('sair', ['DESCADASTRAR'])).toBeUndefined()
    expect(parseOptOutKeywords(' sair , remover ')).toEqual(['SAIR', 'REMOVER'])
    expect(parseOptOutKeywords('')).toEqual(['SAIR', 'PARAR', 'STOP', 'CANCELAR'])
  })
})

describe('jidToE164', () => {
  it.each([
    ['5511999999999@s.whatsapp.net', '+5511999999999'],
    ['5511999999999:12@s.whatsapp.net', '+5511999999999'],
    ['5511999999999@c.us', '+5511999999999'],
    ['120363000000000000@g.us', undefined],
    ['123456789@lid', undefined],
    ['status@broadcast', undefined],
  ])('%s → %s', (jid, phone) => {
    expect(jidToE164(jid)).toBe(phone)
  })
})

describe('parseCsv', () => {
  it('aspas, vírgulas, aspas escapadas, CRLF e BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
    ])
  })

  it('detecta ";"', () => {
    expect(parseCsv('phone;name\n+551199;Ana')).toEqual([
      ['phone', 'name'],
      ['+551199', 'Ana'],
    ])
  })
})

describe('parseContactsCsv', () => {
  const header = 'name,phone,consent,consent_at,consent_source'

  it('aceita só linhas com consentimento completo', () => {
    const csv = [
      header,
      'Ana,+5511900000001,true,2026-01-01T00:00:00Z,site',
      'Bia,+5511900000002,false,2026-01-01T00:00:00Z,site',
      'Caio,+5511900000003,true,,site',
      'Duda,+5511900000004,true,2026-01-01T00:00:00Z,',
      'Eva,11900000005,true,2026-01-01T00:00:00Z,site',
      'Fabi,+5511900000006,true,not-a-date,site',
      'Ana2,+5511900000001,true,2026-01-01T00:00:00Z,site',
      '',
    ].join('\n')
    const { accepted, rejected } = parseContactsCsv(csv)
    expect(accepted.map((r) => r.phone)).toEqual(['+5511900000001'])
    expect(accepted[0]).toMatchObject({ name: 'Ana', consent: true, consentSource: 'site', line: 2 })
    expect(rejected.map((r) => [r.line, r.reason])).toEqual([
      [3, 'consent_not_true'],
      [4, 'missing_consent_at'],
      [5, 'missing_consent_source'],
      [6, 'invalid_phone'],
      [7, 'invalid_consent_at'],
      [8, 'duplicate_in_file'],
    ])
    expect(rejected[0]?.message).toBeTruthy()
  })

  it('sem coluna phone → erro de cabeçalho', () => {
    expect(() => parseContactsCsv('name,consent\nAna,true')).toThrow(/phone/)
  })
})
