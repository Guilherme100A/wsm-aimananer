// Grupos (T14): somente visualização e atualização manual. Nunca entra em grupos automaticamente.
// T20: em grupos em que a sessão é admin, "Adicionar número" adiciona UMA sessão do sistema, com confirmação.
import { useState } from 'react'
import { GroupAddDialog } from '../components/GroupAddDialog'
import { ErrorText } from '../components/ui'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import { indicatorText } from '../lib/states'
import { NOT_ADMIN_HINT, type GroupWithAdmin } from './Groups.logic'

export function Groups() {
  const sessions = usePoll(() => api.sessions(), POLL.page)
  const [sessionId, setSessionId] = useState('')
  const [groups, setGroups] = useState<GroupWithAdmin[]>()
  const [adding, setAdding] = useState<GroupWithAdmin>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)

  async function load(id: string, refresh = false) {
    setSessionId(id)
    setGroups(undefined)
    setAdding(undefined)
    setError(undefined)
    if (!id) return
    setBusy(true)
    try {
      setGroups(refresh ? await api.refreshGroups(id) : await api.groups(id))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="page-groups">
      <h1>Grupos</h1>
      <div className="panel inline-form">
        <label htmlFor="groups-session">Sessão</label>
        <select id="groups-session" data-testid="groups-session" value={sessionId} onChange={(e) => load(e.target.value)}>
          <option value="">Selecione…</option>
          {(sessions.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.phone}) — {indicatorText(s.status)}
            </option>
          ))}
        </select>
        <button type="button" data-testid="groups-refresh" disabled={!sessionId || busy} onClick={() => load(sessionId, true)}>
          Atualizar
        </button>
      </div>
      <ErrorText error={error} testId="groups-error" />
      {groups ? (
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Participantes</th>
              <th>Envio</th>
              <th>Comunidade</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id} data-testid="group-row" data-group-id={g.id}>
                <td>{g.name}</td>
                <td>{g.participants}</td>
                <td>{g.announce ? 'Somente admins' : 'Aberto'}</td>
                <td>{g.communityId ?? '—'}</td>
                <td>
                  <button
                    type="button"
                    data-testid="group-add-number"
                    disabled={!g.isAdmin}
                    title={g.isAdmin ? 'Adicionar uma sessão do sistema a este grupo' : NOT_ADMIN_HINT}
                    onClick={() => setAdding(g)}
                  >
                    Adicionar número
                  </button>
                  {!g.isAdmin ? (
                    <small className="hint" data-testid="group-add-hint">
                      {NOT_ADMIN_HINT}
                    </small>
                  ) : null}
                </td>
              </tr>
            ))}
            {groups.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  Nenhum grupo
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
      {adding && sessionId ? (
        <GroupAddDialog
          key={adding.id}
          adminSessionId={sessionId}
          group={adding}
          sessions={sessions.data ?? []}
          onClose={() => setAdding(undefined)}
          onAdded={() => void api.groups(sessionId).then(setGroups, setError)}
        />
      ) : null}
    </div>
  )
}
