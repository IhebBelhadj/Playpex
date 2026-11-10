import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Caster } from '../core/cast/caster'
import { ServerEvents, type ServerEventMap } from '../core/events/serverEvents'
import { Emitter } from '../core/util/emitter'
import { SessionRegistry } from '../core/playback/registry'
import type { ApiClient } from '../core/http/client'
import { SessionController, type Profile, type SessionState } from '../core/session/session'
import { discovery } from '../native/discovery'
import { serverStore } from '../native/serverStore'
import { useStore } from './hooks'
import { invalidateOnEvents } from './invalidation'

// The app's single instances, made once: the session (which server, who is
// watching) and the query cache. Everything else is made per screen.

/** The server's word to this device's player: the admin's commands, a session that ended */
export type PlayerRemote = Emitter<Pick<ServerEventMap, 'session.command' | 'session.ended'>>

type App = { session: SessionController; queryClient: QueryClient; playbacks: SessionRegistry; remote: PlayerRemote }

const AppContext = createContext<App | null>(null)
// The connected server's caster (core/cast/caster.ts): made with the client, gone with it
const CasterContext = createContext<Caster | null>(null)

function createApp(): App {
  return {
    session: new SessionController(serverStore, discovery),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } }),
    playbacks: new SessionRegistry(),
    remote: new Emitter(),
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
  const caster = useMemo(() => (client ? new Caster(client) : null), [client])
  useEffect(() => {
    if (!caster) return
    caster.start()
    return () => caster.stop()
  }, [caster])
  useEffect(() => {
    if (!client || !caster) return
    const events = new ServerEvents(client)
    const offCast = [
      events.events.on('cast.updated', (c) => caster.onCast('cast.updated', c)),
      events.events.on('cast.ended', (c) => caster.onCast('cast.ended', c)),
    ]
    const off = invalidateOnEvents(events, app.queryClient)
    const offCommand = events.events.on('session.command', (c) => app.remote.emit('session.command', c))
    const offEnded = events.events.on('session.ended', (e) => app.remote.emit('session.ended', e))
    events.start()
    return () => {
      off()
      offCommand()
      offEnded()
      offCast.forEach((o) => o())
      events.stop()
    }
  }, [client, caster, app.queryClient, app.remote])

  return (
    <AppContext.Provider value={app}>
      <CasterContext.Provider value={caster}>
        <QueryClientProvider client={app.queryClient}>{children}</QueryClientProvider>
      </CasterContext.Provider>
    </AppContext.Provider>
  )
}

/** The caster while connected (null before) */
export function useCaster(): Caster | null {
  return useContext(CasterContext)
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
