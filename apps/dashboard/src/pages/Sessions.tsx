import { ErrorText, StateIndicator } from '../components/ui'
import { formatDateTime } from '../lib/aggregate'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import { routeHref } from '../lib/router'

export function Sessions() {
  const { data, error } = usePoll(() => api.sessions(), POLL.list)
  return (
    <div data-testid="page-sessions">
      <div className="page-head">
        <h1>Sessões</h1>
        <a className="button" href={routeHref({ name: 'new-session' })} data-testid="add-session">
          + Adicionar número
        </a>
      </div>
      <ErrorText error={error} />
      <table>
        <thead>
          <tr>
            <th>Estado</th>
            <th>Nome</th>
            <th>Número</th>
            <th>Última conexão</th>
            <th>Observação</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((s) => (
            <tr key={s.id} data-testid="session-row" data-session-id={s.id} data-state={s.status}>
              <td>
                <StateIndicator state={s.status} />
              </td>
              <td>
                <a href={routeHref({ name: 'session', id: s.id })} data-testid="session-link">
                  {s.name}
                </a>
              </td>
              <td>{s.phone}</td>
              <td>{formatDateTime(s.lastConnectedAt)}</td>
              <td>{s.note ?? ''}</td>
            </tr>
          ))}
          {data && data.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                Nenhuma sessão
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
