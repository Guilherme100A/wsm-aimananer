// "+ Adicionar número" (AC-T12-04): cria a sessão e autentica por QR ou pairing code até conectar.
import { useEffect, useState, type FormEvent } from 'react'
import { ErrorText, StateIndicator } from '../components/ui'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import { routeHref } from '../lib/router'
import type { Session, SessionState } from '../lib/types'

type Mode = 'qr' | 'pairing'

export function NewSession() {
  const proxies = usePoll(() => api.proxies(), 0)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [proxyId, setProxyId] = useState('')
  const [note, setNote] = useState('')
  const [session, setSession] = useState<Session>()
  const [mode, setMode] = useState<Mode>()
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState<string>()
  const [state, setState] = useState<SessionState>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)

  const connected = state !== undefined && state !== 'NEW' && state !== 'DISCONNECTED'
  const waiting = !!session && !!mode && !connected

  // Polling do estado (e do QR) até conectar.
  useEffect(() => {
    if (!session || !mode || connected) return
    let alive = true
    const timer = setInterval(async () => {
      try {
        const s = await api.session(session.id)
        if (!alive) return
        setState(s.status)
        if (mode === 'qr' && s.status === 'NEW') {
          const info = await api.getQr(session.id)
          if (alive && info.qr) setQr(info.qr)
        }
      } catch (err) {
        if (alive) setError(err)
      }
    }, POLL.fast)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [session, mode, connected])

  async function ensureSession(): Promise<Session> {
    if (session) return session
    const created = await api.createSession({
      name: name.trim(),
      phone: phone.trim(),
      proxyId: proxyId || null,
      note: note.trim() || null,
    })
    setSession(created)
    setState(created.status)
    return created
  }

  async function start(e: FormEvent | undefined, m: Mode) {
    e?.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const s = await ensureSession()
      setMode(m)
      if (m === 'qr') {
        setCode(undefined)
        await api.startQr(s.id)
        const info = await api.getQr(s.id)
        if (info.qr) setQr(info.qr)
      } else {
        setQr(null)
        const r = await api.pairingCode(s.id, phone.trim() || undefined)
        setCode(r.code)
      }
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="page-new-session">
      <h1>Adicionar número</h1>
      <form className="panel form" onSubmit={(e) => start(e, 'qr')}>
        <label htmlFor="new-name">Nome</label>
        <input id="new-name" data-testid="new-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!!session} required />
        <label htmlFor="new-phone">Número</label>
        <input
          id="new-phone"
          data-testid="new-phone"
          placeholder="+5511999999999"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={!!session}
          required
        />
        <label htmlFor="new-proxy">Proxy/IP</label>
        <select id="new-proxy" data-testid="new-proxy" value={proxyId} onChange={(e) => setProxyId(e.target.value)} disabled={!!session}>
          <option value="">Sem proxy</option>
          {(proxies.data ?? [])
            .filter((p) => !p.sessionId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ? `${p.name} — ` : ''}
                {p.url}
              </option>
            ))}
        </select>
        <label htmlFor="new-note">Observação</label>
        <textarea id="new-note" data-testid="new-note" value={note} onChange={(e) => setNote(e.target.value)} disabled={!!session} />
        <div className="actions">
          <button type="submit" data-testid="gen-qr" disabled={busy || connected}>
            Gerar QR Code
          </button>
          <button type="button" data-testid="gen-pairing" disabled={busy || connected} onClick={() => start(undefined, 'pairing')}>
            Gerar Pairing Code
          </button>
        </div>
      </form>

      <ErrorText error={error} testId="auth-error" />

      {waiting && mode === 'qr' ? (
        <div className="panel auth">
          <p>Escaneie o QR Code no WhatsApp (Aparelhos conectados). Ele é atualizado até conectar.</p>
          {qr ? <img data-testid="qr-image" src={qr} alt="QR Code" width={264} height={264} /> : <p className="muted">Aguardando QR…</p>}
        </div>
      ) : null}
      {waiting && mode === 'pairing' ? (
        <div className="panel auth">
          <p>Digite o código em WhatsApp → Aparelhos conectados → Conectar com número.</p>
          {code ? (
            <p className="pairing" data-testid="pairing-code">
              {code}
            </p>
          ) : (
            <p className="muted">Aguardando código…</p>
          )}
        </div>
      ) : null}
      {connected && session && state ? (
        <div className="panel auth" data-testid="auth-connected">
          <p>
            Conectado: <StateIndicator state={state} testId="connect-state" />
          </p>
          <a href={routeHref({ name: 'session', id: session.id })} data-testid="session-open">
            Abrir sessão
          </a>
        </div>
      ) : null}
    </div>
  )
}
