// Precisa rodar antes de qualquer import de @wsm/*: env do T09 (CREDENTIALS_KEY, WA_TRANSPORT=fake) e o
// ambiente de IA do T13 que serve de fallback quando não há linha em ai_settings (AC-T19-01).
// Sem AI_PROVIDER_API_KEY no env do processo: assim "remover a chave" leva a hasApiKey=false.
import '../T09/env'

export const ENV_AI = {
  AI_MODEL_SMALL: 'env-modelo-pequeno',
  AI_MODEL_LARGE: 'env-modelo-grande',
  AI_CONFIDENCE_THRESHOLD: '0.7',
  AI_MAX_TOKENS: '300',
  AI_TIMEOUT_MS: '4000',
}

Object.assign(process.env, ENV_AI)
delete process.env.AI_PROVIDER_API_KEY
delete process.env.AI_ENABLED
