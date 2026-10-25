import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { API_PREFIX, type LogEntry } from './api'

// One WebSocket to /api/v1/events for the whole dashboard (plan §6.4). It
// refreshes the queries an event changes, and pages can listen to topics
// (Logs: `log`; Overview / Activity: `torrent.stats`).

export interface ServerEvent<T = unknown> {
  topic: string
  time: string
  data: T
}

type Listener = (event: ServerEvent) => void

interface EventsContextValue {
  connected: boolean
  subscribe: (prefix: string, listener: Listener) => () => void
}

const EventsContext = createContext<EventsContextValue>({
  connected: false,
  subscribe: () => () => {},
})

// topic prefix → queries to refresh
const INVALIDATES: [string, string[]][] = [
  ['session.', ['sessions', 'torrents', 'overview']],
  ['device.', ['devices']],
  ['pairing.', ['pairing', 'devices']],
  ['host.', ['host']],
  // download.updated (every 2 s per torrent) is patched in place by the Downloads page
  ['download.added', ['downloads', 'overview']],
  ['download.removed', ['downloads', 'storage', 'overview']],
  // a plugin loaded, stopped or was removed (its library.match: the folders' information providers)
  ['plugin.changed', ['admin-plugins', 'admin-plugin', 'admin-plugin-settings', 'admin-plugin-channels', 'library']],
]

export function EventsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const client = useQueryClient()
  const listeners = useRef(new Map<Listener, string>())
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = 1000
    let closed = false

    const open = () => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${scheme}//${location.host}${API_PREFIX}/events`)
      socket.onopen = () => {
        delay = 1000
        setConnected(true)
      }
      socket.onmessage = (message) => {
        let event: ServerEvent
        try {
          event = JSON.parse(message.data as string)
        } catch {
          return
        }
        for (const [prefix, keys] of INVALIDATES) {
          if (event.topic.startsWith(prefix)) {
            keys.forEach((key) => client.invalidateQueries({ queryKey: [key] }))
          }
        }
        listeners.current.forEach((prefix, listener) => {
          if (event.topic.startsWith(prefix)) listener(event)
        })
      }
      socket.onclose = () => {
        setConnected(false)
        if (!closed) {
          retry = setTimeout(open, delay)
          delay = Math.min(delay * 2, 15_000)
        }
      }
    }
    open()
    return () => {
      closed = true
      clearTimeout(retry)
      socket?.close()
    }
  }, [enabled, client])

  const subscribe = useCallback((prefix: string, listener: Listener) => {
    listeners.current.set(listener, prefix)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])
  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe])
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
}

export function useEventsConnected() {
  return useContext(EventsContext).connected
}

/** Calls `listener` for every event whose topic starts with `prefix`. */
export function useEvent<T = unknown>(prefix: string, listener: (event: ServerEvent<T>) => void) {
  const { subscribe } = useContext(EventsContext)
  const latest = useRef(listener)
  useEffect(() => {
    latest.current = listener
  })
  useEffect(() => subscribe(prefix, (e) => latest.current(e as ServerEvent<T>)), [prefix, subscribe])
}

export type LogEvent = ServerEvent<LogEntry>
