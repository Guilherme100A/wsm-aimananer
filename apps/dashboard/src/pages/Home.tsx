import { Card, ErrorText, PageHeader } from '../components/ui'
import { formatDateTime, summarizeHome } from '../lib/aggregate'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import type { SessionHealth } from '../lib/types'

async function loadHome() {
  const sessions = await api.sessions()
  const entries = await Promise.all(
    sessions.map(async (s) => [s.id, await api.health(s.id).catch(() => undefined)] as const),
  )
  const health: Record<string, SessionHealth | undefined> = Object.fromEntries(entries)
  return summarizeHome(sessions, health)
}

export function Home() {
  const { data, error } = usePoll(loadHome, POLL.page)
  const v = (n: number | undefined) => (n === undefined ? '…' : n)
  return (
    <div data-testid="page-home">
      <PageHeader title="Visão geral" subtitle="Estado das sessões e volume de mensagens nas últimas 24 horas." />
      <ErrorText error={error} />
      <div className="cards">
        <Card testId="card-connected" title="Conectadas" value={v(data?.connected)} />
        <Card testId="card-disconnected" title="Desconectadas" value={v(data?.disconnected)} />
        <Card testId="card-warming" title="Em warm-up" value={v(data?.warming)} />
        <Card testId="card-risk" title="Risco elevado" value={v(data?.risk)} hint="Degraded ou Health Warning/Critical" />
        <Card testId="card-sent" title="Enviadas" value={v(data?.sent)} hint="últimas 24h" />
        <Card testId="card-received" title="Recebidas" value={v(data?.received)} hint="últimas 24h" />
        <Card testId="card-failed" title="Falhas" value={v(data?.failed)} hint="últimas 24h" />
        <Card testId="card-last-event" title="Último evento" value={data ? formatDateTime(data.lastEventAt) : '…'} />
      </div>
      <p className="muted">O Health Score é apenas um indicador operacional.</p>
    </div>
  )
}
