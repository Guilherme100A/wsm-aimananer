import { useState } from 'react'
import { ErrorText } from '../components/ui'
import { formatDateTime } from '../lib/aggregate'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import type { ImportResult } from '../lib/types'

export function Contacts() {
  const { data, error, reload } = usePoll(() => api.contacts(), POLL.page)
  const [csv, setCsv] = useState('')
  const [result, setResult] = useState<ImportResult>()
  const [importError, setImportError] = useState<unknown>()
  const [busy, setBusy] = useState(false)

  async function importCsv(text: string) {
    if (!text.trim()) return setImportError(new Error('CSV vazio'))
    setBusy(true)
    setImportError(undefined)
    try {
      setResult(await api.importContacts(text))
      setCsv('')
      reload()
    } catch (err) {
      setImportError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="page-contacts">
      <h1>Contatos</h1>
      <section className="panel">
        <h3>Importar CSV</h3>
        <p className="muted">Colunas: phone (obrigatória), name, consent, consent_at, consent_source, last_contact_at. Cada linha precisa de consent=true, consent_at e consent_source.</p>
        <input
          type="file"
          accept=".csv,text/csv"
          data-testid="csv-file"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (file) await importCsv(await file.text())
            e.target.value = ''
          }}
        />
        <textarea data-testid="csv-text" rows={4} placeholder="phone,name,consent,consent_at,consent_source" value={csv} onChange={(e) => setCsv(e.target.value)} />
        <button type="button" data-testid="csv-import" disabled={busy} onClick={() => importCsv(csv)}>
          Importar
        </button>
        <ErrorText error={importError} testId="csv-error" />
        {result ? (
          <div data-testid="csv-result">
            <p>
              imported {result.imported} · rejeitados {result.rejected.length}
            </p>
            {result.rejected.length > 0 ? (
              <ul>
                {result.rejected.map((r) => (
                  <li key={r.line}>
                    linha {r.line}: {r.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>
      <ErrorText error={error} />
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Telefone</th>
            <th>Consentimento</th>
            <th>Opt-out</th>
            <th>Último contato</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((c) => (
            <tr key={c.id} data-testid="contact-row" data-contact-id={c.id}>
              <td>{c.name ?? '—'}</td>
              <td>{c.phone}</td>
              <td>{c.consent ? `Sim${c.consent_source ? ` (${c.consent_source})` : ''}` : 'Não'}</td>
              <td>{c.opt_out ? 'Sim' : 'Não'}</td>
              <td>{formatDateTime(c.last_contact_at)}</td>
            </tr>
          ))}
          {data && data.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                Nenhum contato
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
