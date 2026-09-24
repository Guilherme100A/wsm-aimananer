// Fallback determinístico (AC-T13-05): classificação por regras e resposta por template.
// Usado sem provedor configurado ou quando o provedor falha/estoura o timeout. Mesmo input → mesmo output.
import { normalizeAiText } from './text'

export const AI_INTENTS = ['greeting', 'pricing', 'scheduling', 'support', 'complaint', 'thanks', 'question', 'other'] as const
export type AiIntent = (typeof AI_INTENTS)[number]

export const FALLBACK_MODEL = 'fallback'

export interface Classification {
  intent: string
  confidence: number
  text: string
}

/** Remove acentos para casar palavras-chave (ex.: "preço" → "preco"). */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '')

// Ordem = prioridade (reclamação vence saudação: "oi, meu pedido veio errado").
const RULES: Array<{ intent: AiIntent; patterns: RegExp[] }> = [
  {
    intent: 'complaint',
    patterns: [/reclama/, /pessim/, /horrivel/, /insatisfeit/, /absurd/, /descaso/, /veio errad/, /nao chegou/, /atrasad/, /\bcomplain/, /\bterrible\b/],
  },
  {
    intent: 'support',
    patterns: [/\bajuda\b/, /\bsuporte\b/, /\berro\b/, /\bproblema/, /nao consigo/, /nao funciona/, /\bdefeito/, /\bhelp\b/, /\bissue\b/],
  },
  { intent: 'pricing', patterns: [/\bpreco/, /\bvalor/, /quanto custa/, /\borcamento/, /\bpagamento/, /\bprice\b/, /\bcost\b/] },
  { intent: 'scheduling', patterns: [/\bagend/, /\bhorario/, /\bmarcar\b/, /\bagenda\b/, /\bdisponivel/, /\bdisponibilidade/, /\bschedule/, /\bappointment/] },
  { intent: 'thanks', patterns: [/\bobrigad/, /\bvaleu\b/, /\bagradec/, /\bthank/] },
  { intent: 'greeting', patterns: [/^(oi|ola|opa|e ai|bom dia|boa tarde|boa noite|hello|hi|hey)\b/] },
]

const TEMPLATES: Record<AiIntent, string> = {
  greeting: 'Olá! Obrigado pelo contato. Como posso ajudar?',
  pricing: 'Obrigado pelo interesse! Vou verificar os valores e já retorno com as informações.',
  scheduling: 'Claro! Pode me informar o dia e o horário de sua preferência para verificarmos a disponibilidade?',
  support: 'Sinto muito pelo transtorno. Pode me dar mais detalhes do que está acontecendo para que possamos ajudar?',
  complaint: 'Lamentamos muito pelo ocorrido. Vamos analisar a sua situação e retornar o mais breve possível.',
  thanks: 'Nós que agradecemos! Se precisar de algo mais, é só chamar.',
  question: 'Obrigado pela pergunta! Vou verificar e já retorno com a resposta.',
  other: 'Recebemos a sua mensagem. Em breve retornaremos.',
}

export function fallbackTemplate(intent: AiIntent): string {
  return TEMPLATES[intent]
}

/** Classifica por regras. Confiança fixa: 0.5 com palavra-chave, 0.4 para pergunta genérica, 0.2 para "other". */
export function fallbackClassify(text: string): Classification {
  const t = fold(normalizeAiText(text))
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(t))) return { intent: rule.intent, confidence: 0.5, text: TEMPLATES[rule.intent] }
  }
  if (t.includes('?')) return { intent: 'question', confidence: 0.4, text: TEMPLATES.question }
  return { intent: 'other', confidence: 0.2, text: TEMPLATES.other }
}
