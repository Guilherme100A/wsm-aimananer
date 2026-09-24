// Bloco "Proxy" (Protocolo, IP/Host, Porta, Usuário, Senha), usado no cadastro e na edição da sessão.
import { PROXY_PROTOCOLS, type ProxyFormValues } from '../lib/proxy-form'
import type { ProxyProtocol } from '../lib/types'

export function ProxyFields({
  prefix,
  value,
  onChange,
  disabled,
  passwordPlaceholder,
}: {
  /** Prefixo dos ids/data-testids (ex.: `new-proxy` → `new-proxy-host`). */
  prefix: string
  value: ProxyFormValues
  onChange: (v: ProxyFormValues) => void
  disabled?: boolean
  passwordPlaceholder?: string
}) {
  const set = <K extends keyof ProxyFormValues>(k: K, v: ProxyFormValues[K]) => onChange({ ...value, [k]: v })
  const id = (f: string) => `${prefix}-${f}`
  return (
    <fieldset className="proxy-fields" disabled={disabled}>
      <legend>Proxy</legend>
      <label htmlFor={id('protocol')}>Protocolo</label>
      <select id={id('protocol')} data-testid={id('protocol')} value={value.protocol} onChange={(e) => set('protocol', e.target.value as ProxyProtocol)}>
        {PROXY_PROTOCOLS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <label htmlFor={id('host')}>IP/Host</label>
      <input id={id('host')} data-testid={id('host')} placeholder="10.0.0.1" value={value.host} onChange={(e) => set('host', e.target.value)} />
      <label htmlFor={id('port')}>Porta</label>
      <input
        id={id('port')}
        data-testid={id('port')}
        inputMode="numeric"
        placeholder="8080"
        value={value.port}
        onChange={(e) => set('port', e.target.value)}
      />
      <label htmlFor={id('username')}>Usuário</label>
      <input id={id('username')} data-testid={id('username')} autoComplete="off" value={value.username} onChange={(e) => set('username', e.target.value)} />
      <label htmlFor={id('password')}>Senha</label>
      <input
        id={id('password')}
        data-testid={id('password')}
        type="password"
        autoComplete="new-password"
        placeholder={passwordPlaceholder}
        value={value.password}
        onChange={(e) => set('password', e.target.value)}
      />
    </fieldset>
  )
}
