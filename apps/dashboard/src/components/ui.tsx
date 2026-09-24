import type { ReactNode } from 'react'
import { STATE_INDICATORS } from '../lib/states'
import type { SessionState } from '../lib/types'

/**
 * Pílula de estado. O textContent continua "<ícone> <rótulo>" (SPEC 3.2); o emoji fica num span
 * aria-hidden que o CSS desenha como um ponto na cor do estado.
 */
export function StateIndicator({ state, testId = 'session-state' }: { state: SessionState; testId?: string }) {
  const i = STATE_INDICATORS[state]
  return (
    <span className={`state state-${state.toLowerCase()}`} data-testid={testId} data-state={state}>
      {i ? (
        <>
          <span className="state-dot" aria-hidden="true">
            {i.icon}
          </span>{' '}
          {i.label}
        </>
      ) : (
        state
      )}
    </span>
  )
}

export function Card({ testId, title, value, hint }: { testId: string; title: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card" data-testid={testId}>
      <div className="card-title">{title}</div>
      <div className="card-value" data-testid="card-value">
        {value}
      </div>
      {hint ? <div className="card-hint">{hint}</div> : null}
    </div>
  )
}

/** Cabeçalho de página: título (h1), subtítulo opcional e ações à direita. */
export function PageHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </header>
  )
}

/** Container de gráfico: sempre renderiza; sem dados mostra "Sem dados". */
export function ChartBox({ testId, title, empty, note, children }: { testId: string; title: string; empty: boolean; note?: string; children: ReactNode }) {
  return (
    <section className="chart" data-testid={testId}>
      <h3>{title}</h3>
      {empty ? <p className="empty">Sem dados</p> : <div className="chart-body">{children}</div>}
      {note ? <p className="chart-note">{note}</p> : null}
    </section>
  )
}

export function ErrorText({ error, testId }: { error: unknown; testId?: string }) {
  if (!error) return null
  const message = error instanceof Error ? error.message : String(error)
  return (
    <p className="error" role="alert" data-testid={testId}>
      {message}
    </p>
  )
}
