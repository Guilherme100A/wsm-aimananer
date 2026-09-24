// Servidores locais para receber entregas de alertas (T11): HTTP (webhook genérico, Discord, Telegram)
// e um SMTP mínimo (sem TLS/AUTH). Nada sai do loopback.
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'

export interface MockRequest {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  /** corpo cru (bytes em utf8), exatamente como recebido */
  raw: string
  /** corpo JSON (se parseável) */
  json: any
}

export interface HttpMock {
  url: string
  port: number
  requests: MockRequest[]
  /** Status das próximas respostas, em ordem (depois disso, `defaultStatus`). */
  queue: number[]
  defaultStatus: number
  /** Requisições cujo caminho começa com `prefix`. */
  on(prefix: string): MockRequest[]
  reset(): void
  close(): Promise<void>
}

/** `host`: '127.0.0.1' (default) ou '0.0.0.0' para receber de containers via host.docker.internal (T16). */
export async function startHttpMock(host = '127.0.0.1'): Promise<HttpMock> {
  const requests: MockRequest[] = []
  const mock = {
    requests,
    queue: [] as number[],
    defaultStatus: 200,
  } as HttpMock
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let json: any
      try {
        json = raw ? JSON.parse(raw) : undefined
      } catch {
        json = undefined
      }
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, raw, json })
      const status = mock.queue.length ? mock.queue.shift()! : mock.defaultStatus
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(status < 300 ? '{"ok":true}' : '{"ok":false}')
    })
  })
  await new Promise<void>((r) => server.listen(0, host, r))
  mock.port = (server.address() as AddressInfo).port
  mock.url = `http://127.0.0.1:${mock.port}`
  mock.on = (prefix) => requests.filter((r) => r.path.startsWith(prefix))
  mock.reset = () => {
    requests.length = 0
    mock.queue.length = 0
    mock.defaultStatus = 200
  }
  mock.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections?.()
      server.close(() => r())
    })
  return mock
}

export interface SmtpMail {
  from: string
  to: string[]
  data: string
}

export interface SmtpMock {
  url: string
  port: number
  mails: SmtpMail[]
  close(): Promise<void>
}

/** SMTP mínimo: EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP, QUIT. Sem STARTTLS nem AUTH. */
export async function startSmtpMock(): Promise<SmtpMock> {
  const mails: SmtpMail[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buf = ''
    let inData = false
    let cur: SmtpMail = { from: '', to: [], data: '' }
    const reply = (s: string) => socket.write(`${s}\r\n`)
    reply('220 localhost mock ESMTP')
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n')
          if (end < 0) return
          cur.data = buf.slice(0, end).replace(/\r\n\.\./g, '\r\n.')
          buf = buf.slice(end + 5)
          inData = false
          mails.push(cur)
          cur = { from: '', to: [], data: '' }
          reply('250 2.0.0 queued')
          continue
        }
        const nl = buf.indexOf('\r\n')
        if (nl < 0) return
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        const cmd = line.slice(0, 4).toUpperCase()
        if (cmd === 'EHLO') {
          reply('250-localhost')
          reply('250 8BITMIME')
        } else if (cmd === 'HELO') reply('250 localhost')
        else if (cmd === 'MAIL') {
          cur.from = /<([^>]*)>/.exec(line)?.[1] ?? ''
          reply('250 2.1.0 ok')
        } else if (cmd === 'RCPT') {
          cur.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '')
          reply('250 2.1.5 ok')
        } else if (cmd === 'DATA') {
          inData = true
          reply('354 end with <CRLF>.<CRLF>')
        } else if (cmd === 'RSET') {
          cur = { from: '', to: [], data: '' }
          reply('250 ok')
        } else if (cmd === 'NOOP') reply('250 ok')
        else if (cmd === 'QUIT') {
          reply('221 bye')
          socket.end()
        } else reply('502 not implemented')
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    url: `smtp://127.0.0.1:${port}`,
    mails,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy()
        server.close(() => r())
      }),
  }
}

/** Porta local sem ninguém escutando (conexão recusada). */
export async function deadPort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}
