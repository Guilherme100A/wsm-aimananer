// AC-T10-02: Health Score 0–100, rótulos Good/Warning/Critical, função pura (tabela de casos).
import { describe, expect, it } from 'vitest'
import { coreApi, score, type ScoreInput } from './shared'

const clean: ScoreInput = { sent: 50, received: 50, failed: 0, disconnects: 0, forbidden403: 0, errorTrend: 0 }
const worst: ScoreInput = { sent: 50, received: 0, failed: 50, disconnects: 20, forbidden403: 3, errorTrend: 50 }

describe('T10 — Health Score (função pura)', () => {
  it('AC-T10-02 healthLabel: tabela de limites Good (≥ 70), Warning (40–69), Critical (< 40)', () => {
    const healthLabel = coreApi.healthLabel
    expect(typeof healthLabel, '@wsm/core deve exportar healthLabel').toBe('function')
    const table: Array<[number, string]> = [
      [100, 'Good'],
      [85, 'Good'],
      [70, 'Good'],
      [69, 'Warning'],
      [55, 'Warning'],
      [40, 'Warning'],
      [39, 'Critical'],
      [10, 'Critical'],
      [0, 'Critical'],
    ]
    for (const [s, label] of table) expect(healthLabel(s), `healthLabel(${s})`).toBe(label)
  })

  it('AC-T10-02 tabela de casos: score inteiro 0..100 com rótulo coerente', () => {
    const cases: Array<{ name: string; input: ScoreInput; expectLabel?: string }> = [
      { name: 'sem atividade', input: { sent: 0, received: 0, failed: 0, disconnects: 0, forbidden403: 0 }, expectLabel: 'Good' },
      { name: 'saudável', input: clean, expectLabel: 'Good' },
      { name: 'uma falha em muitos envios', input: { ...clean, sent: 200, received: 150, failed: 1 }, expectLabel: 'Good' },
      { name: 'pior caso', input: worst, expectLabel: 'Critical' },
      { name: 'muitos 403', input: { ...clean, forbidden403: 10 } },
      { name: 'muitas desconexões', input: { ...clean, disconnects: 30 } },
      { name: 'muitas falhas', input: { ...clean, failed: 100, errorTrend: 100 } },
      { name: 'sem respostas', input: { ...clean, received: 0 } },
    ]
    for (const c of cases) {
      const r = score(c.input)
      expect(Number.isInteger(r.score), `${c.name}: score inteiro (${r.score})`).toBe(true)
      expect(r.score, c.name).toBeGreaterThanOrEqual(0)
      expect(r.score, c.name).toBeLessThanOrEqual(100)
      expect(r.label, `${c.name}: rótulo coerente com o score ${r.score}`).toBe(coreApi.healthLabel(r.score))
      if (c.expectLabel) expect(r.label, `${c.name} (score ${r.score})`).toBe(c.expectLabel)
    }
    expect(score({ sent: 0, received: 0, failed: 0, disconnects: 0, forbidden403: 0 }).score, 'sem sinais negativos → 100').toBe(100)
  })

  it('AC-T10-02 cada sinal influencia o score: falhas, desconexões, 403, taxa de resposta e tendência de erros', () => {
    const base = score(clean).score
    expect(score({ ...clean, failed: 20 }).score, 'falhas devem reduzir o score').toBeLessThan(base)
    expect(score({ ...clean, disconnects: 10 }).score, 'desconexões devem reduzir o score').toBeLessThan(base)
    expect(score({ ...clean, forbidden403: 1 }).score, 'evento 403 deve reduzir o score').toBeLessThan(base)
    const mid: ScoreInput = { sent: 50, received: 25, failed: 10, disconnects: 2, forbidden403: 0, errorTrend: 0 }
    expect(score({ ...mid, received: 0 }).score, 'taxa de resposta menor deve reduzir o score').toBeLessThan(score({ ...mid, received: 50 }).score)
    expect(score({ ...mid, errorTrend: 10 }).score, 'tendência de erros crescente deve reduzir o score').toBeLessThan(score({ ...mid, errorTrend: -10 }).score)
  })

  it('AC-T10-02 monotonicidade: piorar um sinal nunca aumenta o score; melhorar a resposta nunca o reduz', () => {
    const grid: ScoreInput[] = []
    for (const failed of [0, 3, 15]) for (const disconnects of [0, 2, 8]) for (const received of [0, 20, 50]) grid.push({ sent: 50, received, failed, disconnects, forbidden403: 0, errorTrend: failed })
    for (const g of grid) {
      const s = score(g).score
      expect(score({ ...g, failed: g.failed + 5 }).score, `+falhas em ${JSON.stringify(g)}`).toBeLessThanOrEqual(s)
      expect(score({ ...g, disconnects: g.disconnects + 2 }).score, `+desconexões em ${JSON.stringify(g)}`).toBeLessThanOrEqual(s)
      expect(score({ ...g, forbidden403: 1 }).score, `+403 em ${JSON.stringify(g)}`).toBeLessThanOrEqual(s)
      expect(score({ ...g, errorTrend: (g.errorTrend ?? 0) + 5 }).score, `+tendência em ${JSON.stringify(g)}`).toBeLessThanOrEqual(s)
      expect(score({ ...g, received: Math.min(g.sent, g.received + 10) }).score, `+respostas em ${JSON.stringify(g)}`).toBeGreaterThanOrEqual(s)
    }
  })

  it('AC-T10-02 pura: mesmo input → mesmo resultado, sem mutar o input e sem depender do relógio', () => {
    const input = { ...worst, sent: 30, received: 10 }
    const snapshot = JSON.stringify(input)
    const a = score(input)
    const b = score(input)
    expect(b).toEqual(a)
    expect(JSON.stringify(input), 'input mutado').toBe(snapshot)
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 365 * 24 * 3_600_000
      expect(score(input), 'score dependeu do relógio').toEqual(a)
    } finally {
      Date.now = realNow
    }
  })

  it('AC-T10-02 os três rótulos são alcançáveis', () => {
    const labels = new Set<string>()
    for (let f = 0; f <= 200; f += 2) labels.add(score({ sent: 100, received: 50, failed: f, disconnects: Math.floor(f / 10), forbidden403: 0, errorTrend: f }).label)
    labels.add(score(worst).label)
    expect([...labels].sort()).toEqual(['Critical', 'Good', 'Warning'])
  })
})
