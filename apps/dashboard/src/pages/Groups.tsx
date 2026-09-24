// Grupos (T14): somente visualização e atualização manual. Nunca entra em grupos automaticamente.
import { useState } from 'react'
import { ErrorText } from '../components/ui'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import { indicatorText } from '../lib/states'
import type { Group } from '../lib/types'

export function Groups() {
  const sessions = usePoll(() => api.sessions(), POLL.page)
  const [sessionId, setSessionId] = useState('')
  const [groups, setGroups] = useState<Group[]>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)

  async function load(id: string, refresh = false) {
    setSessionId(id)
    setGroups(undefined)
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
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id} data-testid="group-row" data-group-id={g.id}>
                <td>{g.name}</td>
                <td>{g.participants}</td>
                <td>{g.announce ? 'Somente admins' : 'Aberto'}</td>
                <td>{g.communityId ?? '—'}</td>
              </tr>
            ))}
            {groups.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty">
                  Nenhum grupo
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}
