// Alertas / Webhooks (T11): CRUD dos canais. O segredo nunca é exibido (a API só informa hasSecret).
import { useState, type FormEvent } from 'react'
import { ErrorText } from '../components/ui'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import { ALERT_EVENTS, type WebhookChannel } from '../lib/types'

const CHANNELS: Array<{ value: WebhookChannel; label: string; urlHint: string }> = [
  { value: 'http', label: 'Webhook HTTP', urlHint: 'https://exemplo.com/hook (segredo obrigatório: assina x-wsm-signature)' },
  { value: 'discord', label: 'Discord', urlHint: 'https://discord.com/api/webhooks/…' },
  { value: 'telegram', label: 'Telegram', urlHint: 'https://api.telegram.org (segredo = bot token)' },
  { value: 'email', label: 'Email (SMTP)', urlHint: 'smtp://host:587 (vazio = SMTP_URL)' },
]

export function Alerts() {
  const { data, error, reload } = usePoll(() => api.webhooks(), POLL.page)
  const [name, setName] = useState('')
  const [channel, setChannel] = useState<WebhookChannel>('http')
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [target, setTarget] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [formError, setFormError] = useState<unknown>()
  const [status, setStatus] = useState<string>()

  async function save(e: FormEvent) {
    e.preventDefault()
    setFormError(undefined)
    const config: Record<string, unknown> = {}
    if (channel === 'telegram' && target.trim()) config.chatId = target.trim()
    if (channel === 'email' && target.trim()) config.to = target.trim()
    try {
      await api.createWebhook({ name: name.trim(), channel, url: url.trim(), ...(secret ? { secret } : {}), config, events })
      setName('')
      setUrl('')
      setSecret('')
      setTarget('')
      setEvents([])
      reload()
    } catch (err) {
      setFormError(err)
    }
  }

  async function run(fn: () => Promise<unknown>) {
    setFormError(undefined)
    try {
      await fn()
      reload()
    } catch (err) {
      setFormError(err)
    }
  }

  const hint = CHANNELS.find((c) => c.value === channel)?.urlHint
  return (
    <div data-testid="page-alerts">
      <h1>Alertas / Webhooks</h1>
      <form className="panel form" onSubmit={save}>
        <label htmlFor="webhook-name">Nome</label>
        <input id="webhook-name" data-testid="webhook-name" value={name} onChange={(e) => setName(e.target.value)} required />
        <label htmlFor="webhook-channel">Canal</label>
        <select id="webhook-channel" data-testid="webhook-channel" value={channel} onChange={(e) => setChannel(e.target.value as WebhookChannel)}>
          {CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <label htmlFor="webhook-url">URL</label>
        <input id="webhook-url" data-testid="webhook-url" placeholder={hint} value={url} onChange={(e) => setUrl(e.target.value)} />
        <label htmlFor="webhook-secret">Segredo</label>
        <input id="webhook-secret" data-testid="webhook-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
        {channel === 'telegram' || channel === 'email' ? (
          <>
            <label htmlFor="webhook-target">{channel === 'telegram' ? 'Chat ID' : 'Destinatário'}</label>
            <input id="webhook-target" data-testid="webhook-target" value={target} onChange={(e) => setTarget(e.target.value)} />
          </>
        ) : null}
        <fieldset>
          <legend>Eventos (nenhum = todos)</legend>
          {ALERT_EVENTS.map((ev) => (
            <label key={ev} className="check">
              <input
                type="checkbox"
                checked={events.includes(ev)}
                onChange={(e) => setEvents((cur) => (e.target.checked ? [...cur, ev] : cur.filter((x) => x !== ev)))}
              />
              {ev}
            </label>
          ))}
        </fieldset>
        <button type="submit" data-testid="webhook-save">
          Salvar webhook
        </button>
      </form>
      <ErrorText error={formError ?? error} testId="webhook-error" />
      {status ? <p className="muted">{status}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Canal</th>
            <th>URL</th>
            <th>Eventos</th>
            <th>Segredo</th>
            <th>Ativo</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((w) => (
            <tr key={w.id} data-testid="webhook-row" data-webhook-id={w.id}>
              <td>{w.name}</td>
              <td>{w.channel}</td>
              <td>{w.url}</td>
              <td>{w.events.length ? w.events.join(', ') : 'todos'}</td>
              <td>{w.hasSecret ? 'configurado' : '—'}</td>
              <td>
                <input type="checkbox" checked={w.enabled} onChange={(e) => run(() => api.updateWebhook(w.id, { enabled: e.target.checked }))} />
              </td>
              <td>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    run(async () => {
                      const r = await api.testWebhook(w.id)
                      setStatus(r.ok ? `Teste de "${w.name}" entregue` : `Teste de "${w.name}" falhou: ${r.error ?? ''}`)
                    })
                  }
                >
                  testar
                </button>{' '}
                <button type="button" className="link" onClick={() => run(() => api.deleteWebhook(w.id))}>
                  remover
                </button>
              </td>
            </tr>
          ))}
          {data && data.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty">
                Nenhum webhook
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
