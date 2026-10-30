import type { QueryClient } from '@tanstack/react-query'
import type { ServerEvents } from '../core/events/serverEvents'

// What each server event makes stale: the one place that maps events to
// cached answers (keys are prefixes of those in queries.ts). Screens never
// listen to the socket themselves.

export function invalidateOnEvents(events: ServerEvents, queryClient: QueryClient): () => void {
  const offs = [
    events.events.on('library.changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['library'] })
      void queryClient.invalidateQueries({ queryKey: ['play'] })
    }),
    events.events.on('plugin.changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['plugins'] })
      void queryClient.invalidateQueries({ queryKey: ['catalog', 'extras'] })
    }),
    events.events.on('settings.changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    }),
  ]
  return () => offs.forEach((off) => off())
}
