// Login do administrador (AC-T18-01): usuário e senha → POST /api/auth/login; token em memória + sessionStorage.
import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { setToken } from '../lib/auth'
import { loginErrorMessage } from '../lib/login'
import { navigate } from '../lib/router'

export function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const user = username.trim()
    if (!user || !password) return setError('Informe usuário e senha')
    setBusy(true)
    setError(undefined)
    try {
      const res = await api.login(user, password)
      setToken(res.token)
      navigate({ name: 'home' })
    } catch (err) {
      setError(loginErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit} className="panel">
        <h1>WA Session Manager</h1>
        <label htmlFor="login-username">Usuário</label>
        <input
          id="login-username"
          data-testid="login-username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label htmlFor="login-password">Senha</label>
        <input
          id="login-password"
          data-testid="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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
