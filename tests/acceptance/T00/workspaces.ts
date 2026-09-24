// Contrato de workspaces da SPEC 3.1 (compartilhado pelos testes de T00).
export const WORKSPACES = [
  { name: '@wsm/api', dir: 'apps/api' },
  { name: '@wsm/worker', dir: 'apps/worker' },
  { name: '@wsm/dashboard', dir: 'apps/dashboard' },
  { name: '@wsm/core', dir: 'packages/core' },
  { name: '@wsm/db', dir: 'packages/db' },
] as const

export const REQUIRED_SCRIPTS = ['build', 'typecheck', 'lint', 'test'] as const

export const ENV_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'API_TOKEN',
  'CREDENTIALS_KEY',
  'LOG_LEVEL',
  'AI_PROVIDER_API_KEY',
  'AI_MODEL_SMALL',
  'AI_MODEL_LARGE',
  'SMTP_URL',
] as const

export const COMPOSE_SERVICES = ['dashboard', 'api', 'worker', 'postgres', 'redis'] as const
