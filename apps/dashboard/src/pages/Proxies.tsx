import { useState, type FormEvent } from 'react'
import { ErrorText } from '../components/ui'
import { formatDateTime } from '../lib/aggregate'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'

export function Proxies() {
  const { data, error, reload } = usePoll(() => api.proxies(), POLL.page)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [formError, setFormError] = useState<unknown>()

  async function create(e: FormEvent) {
    e.preventDefault()
    setFormError(undefined)
    try {
      await api.createProxy({ url: url.trim(), name: name.trim() || null })
      setUrl('')
      setName('')
      reload()
    } catch (err) {
      setFormError(err)
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteProxy(id)
      reload()
    } catch (err) {
      setFormError(err)
    }
  }

  return (
    <div data-testid="page-proxies">
      <h1>Proxies</h1>
      <form className="panel inline-form" onSubmit={create}>
        <label htmlFor="proxy-url">URL</label>
        <input id="proxy-url" data-testid="proxy-url" placeholder="socks5://user:senha@host:1080" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <label htmlFor="proxy-name">Nome</label>
        <input id="proxy-name" data-testid="proxy-name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" data-testid="proxy-save">
          Adicionar proxy
        </button>
      </form>
      <ErrorText error={formError ?? error} testId="proxy-error" />
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>URL</th>
            <th>Disponível</th>
            <th>Última verificação</th>
            <th>Sessão</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((p) => (
            <tr key={p.id} data-testid="proxy-row" data-proxy-id={p.id}>
              <td>{p.name ?? '—'}</td>
              <td>{p.url}</td>
              <td>{p.available ? 'Sim' : `Não (${p.lastError ?? 'erro'})`}</td>
              <td>{formatDateTime(p.lastCheckAt)}</td>
              <td>{p.sessionId ?? 'livre'}</td>
              <td>
                <button type="button" className="link" onClick={() => remove(p.id)} disabled={!!p.sessionId}>
                  remover
                </button>
              </td>
            </tr>
          ))}
          {data && data.length === 0 ? (
            <tr>
              <td colSpan={6} className="empty">
                Nenhum proxy
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
