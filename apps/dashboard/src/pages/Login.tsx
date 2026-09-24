import { useState, type FormEvent } from 'react'
import { api, ApiRequestError } from '../lib/api'
import { setToken } from '../lib/auth'
import { navigate } from '../lib/router'

export function Login() {
  const [token, setValue] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = token.trim()
    if (!t) return setError('Informe o API token')
    setBusy(true)
    setError(undefined)
    try {
      await api.checkToken(t)
      setToken(t)
      navigate({ name: 'home' })
    } catch (err) {
      setError(err instanceof ApiRequestError && err.status === 401 ? 'Token inválido' : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit} className="panel">
        <h1>WA Session Manager</h1>
        <label htmlFor="login-token">API token</label>
        <input
          id="login-token"
          data-testid="login-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" data-testid="login-submit" disabled={busy}>
          Entrar
        </button>
        {error ? (
          <p className="error" role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  )
}
