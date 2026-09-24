import { useEffect } from 'react'
import { Layout } from './components/Layout'
import { useRoute, useToken } from './lib/hooks'
import { navigate, type Route } from './lib/router'
import { Alerts } from './pages/Alerts'
import { Contacts } from './pages/Contacts'
import { Groups } from './pages/Groups'
import { Home } from './pages/Home'
import { Login } from './pages/Login'
import { NewSession } from './pages/NewSession'
import { Proxies } from './pages/Proxies'
import { SessionDetail } from './pages/SessionDetail'
import { Sessions } from './pages/Sessions'

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <Home />
    case 'sessions':
      return <Sessions />
    case 'new-session':
      return <NewSession />
    case 'session':
      return <SessionDetail key={route.id} id={route.id} />
    case 'proxies':
      return <Proxies />
    case 'contacts':
      return <Contacts />
    case 'groups':
      return <Groups />
    case 'alerts':
      return <Alerts />
    case 'login':
      return null
    case 'not-found':
      return (
        <div data-testid="page-not-found">
          <h1>Página não encontrada</h1>
          <a href="#/">Voltar ao início</a>
        </div>
      )
  }
}

export function App() {
  const route = useRoute()
  const token = useToken()

  // Sem token, toda rota vai para o login (AC-T12-01); com token, o login vai para a home.
  useEffect(() => {
    if (!token && route.name !== 'login') navigate({ name: 'login' })
    else if (token && route.name === 'login') navigate({ name: 'home' })
  }, [token, route.name])

  if (!token || route.name === 'login') return <Login />
  return (
    <Layout route={route}>
      <Page route={route} />
    </Layout>
  )
}
