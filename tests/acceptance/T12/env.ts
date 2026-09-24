// Precisa rodar antes de qualquer import de @wsm/*: env do T05 + credenciais do admin do painel (AC-T17-01).
// Sem ADMIN_USERNAME/ADMIN_PASSWORD na env, valem os defaults admin/nimda.
import '../T05/env'

export const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'nimda'
