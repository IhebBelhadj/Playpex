import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ServerEvents } from '../core/events/serverEvents'
import { SessionRegistry } from '../core/playback/registry'
import type { ApiClient } from '../core/http/client'
import { SessionController, type Profile, type SessionState } from '../core/session/session'
import { discovery } from '../native/discovery'
import { serverStore } from '../native/serverStore'
import { useStore } from './hooks'
import { invalidateOnEvents } from './invalidation'

// The app's single instances, made once: the session (which server, who is
// watching) and the query cache. Everything else is made per screen.

type App = { session: SessionController; queryClient: QueryClient; playbacks: SessionRegistry }

const AppContext = createContext<App | null>(null)

function createApp(): App {
  return {
    session: new SessionController(serverStore, discovery),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } }),
    playbacks: new SessionRegistry(),
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [app] = useState(createApp)

  // The session boots with the app; another server (or none) makes every cached answer stale
  useEffect(() => {
    const { session, queryClient } = app
    const off = session.events.on('serverChanged', () => queryClient.clear())
    void session.start()
    return () => {
      off()
      session.stop()
    }
  }, [app])

  // The server's events while connected: what they make stale (invalidation.ts)
  const state = useStore(app.session.state)
  const client = state.kind === 'connected' ? state.client : null
  useEffect(() => {
    if (!client) return
    const events = new ServerEvents(client)
    const off = invalidateOnEvents(events, app.queryClient)
    events.start()
    return () => {
      off()
      events.stop()
    }
  }, [client, app.queryClient])

  return (
    <AppContext.Provider value={app}>
      <QueryClientProvider client={app.queryClient}>{children}</QueryClientProvider>
    </AppContext.Provider>
  )
}

export function useApp(): App {
  const app = useContext(AppContext)
  if (!app) throw new Error('useApp outside AppProvider')
  return app
}

export function useSession(): SessionController {
  return useApp().session
}

export function useSessionState(): SessionState {
  return useStore(useApp().session.state)
}

/** The connected server's client, for screens that only show once connected (their routes are guarded) */
export function useClient(): ApiClient {
  const state = useSessionState()
  if (state.kind !== 'connected') throw new Error('No server')
  return state.client
}

/** The profile watching, for screens that only show once one is chosen */
export function useProfile(): Profile {
  const state = useSessionState()
  if (state.kind !== 'connected' || !state.profile) throw new Error('No profile')
  return state.profile
}
