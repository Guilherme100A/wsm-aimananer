import type { ReactNode } from 'react'
import { clearToken } from '../lib/auth'
import { navigate, type Route } from '../lib/router'

const LINKS: Array<{ route: Route['name']; href: string; label: string; testId: string }> = [
  { route: 'home', href: '#/', label: 'Início', testId: 'nav-home' },
  { route: 'sessions', href: '#/sessions', label: 'Sessões', testId: 'nav-sessions' },
  { route: 'proxies', href: '#/proxies', label: 'Proxies', testId: 'nav-proxies' },
  { route: 'contacts', href: '#/contacts', label: 'Contatos', testId: 'nav-contacts' },
  { route: 'groups', href: '#/groups', label: 'Grupos', testId: 'nav-groups' },
  { route: 'alerts', href: '#/alerts', label: 'Alertas', testId: 'nav-alerts' },
]

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const active = route.name === 'session' || route.name === 'new-session' ? 'sessions' : route.name
  return (
    <div className="layout">
      <nav className="nav">
        <strong className="brand">WA Session Manager</strong>
        {LINKS.map((l) => (
          <a key={l.route} href={l.href} data-testid={l.testId} className={active === l.route ? 'active' : undefined}>
            {l.label}
          </a>
        ))}
        <button
          type="button"
          className="link"
          data-testid="nav-logout"
          onClick={() => {
            clearToken()
            navigate({ name: 'login' })
          }}
        >
          Sair
        </button>
      </nav>
      <main className="main">{children}</main>
    </div>
  )
}
