// Detalhe da sessão (AC-T12-05): card da seção 12 da nota + gráficos agregados no cliente.
import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartBox, ErrorText, StateIndicator } from '../components/ui'
import { appendSample, bucketMessages, formatDateTime, latencySeries, parsePrometheusLatency, timeLabel } from '../lib/aggregate'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import { navigate } from '../lib/router'
import { CONNECTED_STATES, indicatorText, STATE_INDICATORS, STATE_LEVEL } from '../lib/states'
import type { Message, SessionState } from '../lib/types'

const H = 220

interface Sample {
  label: string
  disconnects: number
  level: number
  state: SessionState
}

const LEVEL_TICKS = Object.entries(STATE_LEVEL).map(([state, level]) => ({ state: state as SessionState, level }))
const levelName = (level: number) => {
  const s = LEVEL_TICKS.find((t) => t.level === level)?.state
  return s ? STATE_INDICATORS[s].label : String(level)
}

export function SessionDetail({ id }: { id: string }) {
  const session = usePoll(() => api.session(id), POLL.list, [id])
  const health = usePoll(() => api.health(id), POLL.page, [id])
  const messages = usePoll(() => api.messages({ sessionId: id, limit: 500 }), POLL.page, [id])
  const metrics = usePoll(() => api.metrics(), POLL.page, [id])
  const [samples, setSamples] = useState<Sample[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [actionError, setActionError] = useState<unknown>()
  const [busy, setBusy] = useState(false)

  const state = session.data?.status ?? health.data?.state

  // Séries amostradas pelo polling (não há endpoint de histórico): desconexões e estado.
  useEffect(() => {
    const h = health.data
    if (!h) return
    const st = session.data?.status ?? h.state
    setSamples((prev) => appendSample(prev, { label: timeLabel(new Date()), disconnects: h.disconnects, level: STATE_LEVEL[st], state: st }))
  }, [health.data, session.data?.status])

  const now = new Date()
  const msgs: Message[] = useMemo(() => messages.data ?? [], [messages.data])
  const hourly = useMemo(() => bucketMessages(msgs, { now, unit: 'hour', count: 24 }), [msgs])
  const daily = useMemo(() => bucketMessages(msgs, { now, unit: 'day', count: 7 }), [msgs])
  const latency = useMemo(() => latencySeries(msgs), [msgs])
  const metricLatency = useMemo(() => (metrics.data ? parsePrometheusLatency(metrics.data, id) : null), [metrics.data, id])
  const latencyData = latency.length > 0 ? latency : metricLatency ? [{ label: 'média', ms: Math.round(metricLatency.avgMs) }] : []

  async function act(action: 'pause' | 'resume' | 'restart' | 'logout') {
    if (action === 'logout' && !window.confirm('Deslogar este número? Será preciso autenticar de novo.')) return
    setBusy(true)
    setActionError(undefined)
    try {
      await api.action(id, action)
      session.reload()
      health.reload()
      if (action === 'logout') navigate({ name: 'sessions' })
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(false)
    }
  }

  if (session.error && !session.data) return <ErrorText error={session.error} testId="session-error" />
  const h = health.data
  const s = session.data

  return (
    <div data-testid="page-session">
      <h1>
        {s?.name ?? 'Sessão'} <small className="muted">{s?.phone}</small>
      </h1>

      <section className="panel session-card" data-testid="session-card">
        <dl>
          <div>
            <dt>Connected</dt>
            <dd data-testid="detail-connected">
              {state ? (
                <>
                  {CONNECTED_STATES.includes(state) ? 'Sim' : 'Não'} · <StateIndicator state={state} />
                </>
              ) : (
                '…'
              )}
            </dd>
          </div>
          <div>
            <dt>Warm-up</dt>
            <dd data-testid="detail-warmup">{h ? `${h.warmupPercent}%` : '…'}</dd>
          </div>
          <div>
            <dt>Health</dt>
            <dd data-testid="detail-health" className={h ? `health-${h.label.toLowerCase()}` : undefined}>
              {h ? `${h.score} ${h.label}` : '…'}
            </dd>
          </div>
          <div>
            <dt>Sent</dt>
            <dd data-testid="detail-sent">{h?.sent ?? '…'}</dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd data-testid="detail-received">{h?.received ?? '…'}</dd>
          </div>
          <div>
            <dt>Failed</dt>
            <dd data-testid="detail-failed">{h?.failed ?? '…'}</dd>
          </div>
          <div>
            <dt>Disconnects</dt>
            <dd data-testid="detail-disconnects">{h?.disconnects ?? '…'}</dd>
          </div>
        </dl>
        <div className="actions">
          {state === 'PAUSED' ? (
            <button type="button" data-testid="btn-resume" disabled={busy} onClick={() => act('resume')}>
              Resume
            </button>
          ) : (
            <button type="button" data-testid="btn-pause" disabled={busy || !state || !['WARMING', 'STABLE', 'DEGRADED'].includes(state)} onClick={() => act('pause')}>
              Pause
            </button>
          )}
          <button type="button" data-testid="btn-restart" disabled={busy || !state || state === 'DISCONNECTED'} onClick={() => act('restart')}>
            Restart
          </button>
          <button type="button" data-testid="btn-logs" onClick={() => setShowLogs((v) => !v)}>
            Logs
          </button>
          <button type="button" className="danger" data-testid="btn-logout" disabled={busy || !state || state === 'DISCONNECTED'} onClick={() => act('logout')}>
            Logout
          </button>
        </div>
        <ErrorText error={actionError} testId="action-error" />
        <p className="muted">
          Último evento: {formatDateTime(h?.lastEventAt ?? null)} · 403: {h?.forbidden403 ?? 0}. O Health Score é apenas um indicador operacional.
        </p>
      </section>

      {showLogs ? <Logs messages={msgs} /> : null}

      <div className="charts">
        <ChartBox testId="chart-messages-hour" title="Mensagens por hora (24h)" empty={hourly.every((b) => b.total === 0 && b.sent === 0)}>
          <ResponsiveContainer width="100%" height={H}>
            <BarChart data={hourly}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="sent" name="Enviadas" fill="#2e7d32" />
              <Bar dataKey="failed" name="Falhas" fill="#c62828" />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>

        <ChartBox testId="chart-messages-day" title="Mensagens por dia (7 dias)" empty={daily.every((b) => b.total === 0 && b.sent === 0)}>
          <ResponsiveContainer width="100%" height={H}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="sent" name="Enviadas" fill="#2e7d32" />
              <Bar dataKey="failed" name="Falhas" fill="#c62828" />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>

        <ChartBox
          testId="chart-received-sent"
          title="Recebidas vs enviadas (24h)"
          empty={!h || h.sent + h.received === 0}
          note="Fonte: Health Monitor (janela de 24h)."
        >
          <ResponsiveContainer width="100%" height={H}>
            <BarChart data={h ? [{ name: 'Enviadas', value: h.sent }, { name: 'Recebidas', value: h.received }] : []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="value" name="Mensagens" fill="#1565c0" />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>

        <ChartBox testId="chart-failures" title="Falhas por hora (24h)" empty={hourly.every((b) => b.failed === 0)}>
          <ResponsiveContainer width="100%" height={H}>
            <LineChart data={hourly}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Line type="linear" dataKey="failed" name="Falhas" stroke="#c62828" />
            </LineChart>
          </ResponsiveContainer>
        </ChartBox>

        <ChartBox testId="chart-disconnects" title="Desconexões (24h, amostrado)" empty={samples.length === 0} note="Amostrado enquanto a página está aberta.">
          <ResponsiveContainer width="100%" height={H}>
            <LineChart data={samples}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Line type="stepAfter" dataKey="disconnects" name="Desconexões" stroke="#ef6c00" isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartBox>

        <ChartBox
          testId="chart-latency"
          title="Latência de envio (ms)"
          empty={latencyData.length === 0}
          {...(metricLatency ? { note: `Média /metrics (${metricLatency.metric}): ${Math.round(metricLatency.avgMs)} ms` } : {})}
        >
          <ResponsiveContainer width="100%" height={H}>
            <LineChart data={latencyData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="ms" name="Latência (ms)" stroke="#6a1b9a" isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartBox>

        <ChartBox testId="chart-state" title="Estado (amostrado)" empty={samples.length === 0} note={state ? `Atual: ${indicatorText(state)}` : undefined}>
          <ResponsiveContainer width="100%" height={H}>
            <LineChart data={samples}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" />
              <YAxis domain={[0, 5]} ticks={LEVEL_TICKS.map((t) => t.level)} tickFormatter={levelName} width={100} />
              <Tooltip formatter={(v) => levelName(Number(v))} />
              <Line type="stepAfter" dataKey="level" name="Estado" stroke="#37474f" isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartBox>
      </div>
    </div>
  )
}

function Logs({ messages }: { messages: Message[] }) {
  const [open, setOpen] = useState<string>()
  const events = usePoll(() => (open ? api.messageEvents(open) : Promise.resolve([])), 0, [open])
  return (
    <section className="panel" data-testid="logs-panel">
      <h3>Logs de mensagens</h3>
      {messages.length === 0 ? <p className="empty">Sem mensagens</p> : null}
      <table>
        <tbody>
          {messages.slice(0, 100).map((m) => (
            <tr key={m.id} data-testid="log-row">
              <td>{formatDateTime(m.createdAt)}</td>
              <td>{m.phone}</td>
              <td>{m.status}</td>
              <td>{m.lastError ?? ''}</td>
              <td>
                <button type="button" className="link" onClick={() => setOpen(open === m.id ? undefined : m.id)}>
                  eventos
                </button>
                {open === m.id ? (
                  <ul>
                    {(events.data ?? []).map((e) => (
                      <li key={e.id}>
                        {formatDateTime(e.createdAt)} {e.from ?? '∅'} → {e.to}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
