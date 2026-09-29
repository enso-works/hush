import { useEffect } from 'react'

import { Shell } from '@/components/Shell'
import { AppsProvider } from '@/lib/apps'
import { useRoute } from '@/lib/route'
import { useSession } from '@/lib/session'
import { AppPage } from '@/pages/AppPage'
import { Feedback } from '@/pages/Feedback'
import { Login } from '@/pages/Login'
import { Overview } from '@/pages/Overview'

export function App() {
  const { signedIn } = useSession()
  const route = useRoute()

  useEffect(() => {
    document.title = route.page === 'feedback' ? 'Feedback · hush' : 'hush'
  }, [route.page])

  if (!signedIn) return <Login />
  return (
    <AppsProvider>
      <Shell route={route}>
        {route.page === 'app' ? (
          <AppPage key={route.slug} slug={route.slug} />
        ) : route.page === 'feedback' ? (
          <Feedback id={route.id} status={route.status} kind={route.kind} />
        ) : (
          <Overview />
        )}
      </Shell>
    </AppsProvider>
  )
}
