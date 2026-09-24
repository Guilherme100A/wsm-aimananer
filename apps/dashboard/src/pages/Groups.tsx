// Grupos (T14): somente visualização e atualização manual. Nunca entra em grupos automaticamente.
// T20: em grupos em que a sessão é admin, "Adicionar número" adiciona UMA sessão do sistema, com confirmação.
import { useState } from 'react'
import { GroupAddDialog } from '../components/GroupAddDialog'
import { ErrorText, PageHeader } from '../components/ui'
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
      <PageHeader title="Grupos" subtitle="Grupos de cada sessão. Adicionar um número é uma ação manual, uma por vez e com confirmação." />
      <div className="panel inline-form toolbar">
        <label htmlFor="groups-session">Sessão</label>
        <select id="groups-session" data-testid="groups-session" value={sessionId} onChange={(e) => load(e.target.value)}>
          <option value="">Selecione…</option>
          {(sessions.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.phone}) — {indicatorText(s.status)}
            </option>
          ))}
        </select>
        <button type="button" className="secondary" data-testid="groups-refresh" disabled={!sessionId || busy} onClick={() => load(sessionId, true)}>
          Atualizar
        </button>
      </div>
      <ErrorText error={error} testId="groups-error" />
      {groups ? (
        <div className="table-wrap">
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
                <td className="cell-strong">{g.name}</td>
                <td>{g.participants}</td>
                <td>
                  <span className="tag">{g.announce ? 'Somente admins' : 'Aberto'}</span>
                </td>
                <td className="mono muted">{g.communityId ?? '—'}</td>
                <td className="cell-actions">
                  <button
                    type="button"
                    className="secondary btn-sm"
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
        </div>
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
