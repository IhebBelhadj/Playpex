import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { api, errorMessage, unwrap, type Schemas } from './api'
import { useEvent } from './events'
import { DEVICE } from './media'

// Casting from the dashboard (docs/cast-plan.md step 3): the screens that take
// casts (GET /cast/screens), a cast to one (POST /cast/screens/{id}/play), the
// casts running (their CastScreen `playing`, patched by cast.updated) and their
// commands (POST /cast/{id}/commands). The screen chosen in the top bar's cast
// button is kept per browser: while one is chosen, Play sends there
// (`usePlayer`) instead of opening this browser's player.

export type CastScreen = Schemas['CastScreen']
export type Cast = Schemas['Cast']
export type CastRequest = Schemas['CastRequest']
export type CastAction = 'pause' | 'resume' | 'toggle' | 'seek' | 'seekBy' | 'stop'

// the dashboard names itself with its own device id, so the screen says "Cast from <this browser>"
const HEADERS = { 'X-Playpex-Device': DEVICE }

export function useScreens(enabled = true) {
  return useQuery({
    queryKey: ['cast-screens'],
    queryFn: () => unwrap(api.GET('/cast/screens', { headers: HEADERS })),
    select: (screens) => screens.filter((s) => !s.self),
    refetchInterval: 15_000,
    enabled,
  })
}

/** Live positions: cast.updated / cast.ended patch the screens' `playing` */
export function useCastEvents() {
  const client = useQueryClient()
  useEvent<Cast>('cast.', (event) => {
    const c = event.data
    if (!c?.castId) return
    const ended = event.topic === 'cast.ended'
    client.setQueryData<CastScreen[]>(['cast-screens'], (screens) =>
      screens?.map((s) =>
        s.deviceId !== c.deviceId
          ? s
          : ended
            ? s.playing?.castId === c.castId
              ? { ...s, playing: null }
              : s
            : {
                ...s,
                playing: {
                  castId: c.castId,
                  sessionId: c.sessionId,
                  title: c.title,
                  state: c.state,
                  positionS: c.positionS,
                },
              },
      ),
    )
    // durations aren't in CastScreen: kept apart
    if (!ended && typeof c.durationS === 'number') durations.set(c.castId, c.durationS)
    if (ended) client.invalidateQueries({ queryKey: ['cast-screens'] })
  })
}

const durations = new Map<string, number>()
export function castDuration(castId: string | null | undefined): number | null {
  return castId ? (durations.get(castId) ?? null) : null
}

export function useCastTo() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ screen, request }: { screen: { deviceId: string; name: string }; request: CastRequest }) =>
      unwrap(
        api.POST('/cast/screens/{deviceId}/play', {
          params: { path: { deviceId: screen.deviceId } },
          body: request,
          headers: HEADERS,
        }),
      ),
    onSuccess: (_, { screen, request }) => {
      toast.success(`Playing on ${screen.name}`, { description: request.title })
      client.invalidateQueries({ queryKey: ['cast-screens'] })
    },
    onError: (err, { screen }) => toast.error(`Couldn't play on ${screen.name}`, { description: castError(err) }),
  })
}

function castError(err: unknown): string {
  const m = errorMessage(err)
  return /UNSUPPORTED/.test(String((err as { code?: string })?.code)) ? `${m}. That screen doesn't play this kind of video.` : m
}

export function useCastCommand() {
  return useMutation({
    mutationFn: ({ castId, action, positionS, deltaS }: { castId: string; action: CastAction; positionS?: number; deltaS?: number }) =>
      unwrap(
        api.POST('/cast/{castId}/commands', {
          params: { path: { castId } },
          body: { action, positionS, deltaS } as never,
          headers: HEADERS,
        }),
      ),
    onError: (err) => toast.error('The screen didn’t take it', { description: errorMessage(err) }),
  })
}

// ── the screen Play sends to ────────────────────────────────────────────────

const TARGET_KEY = 'playpex.dashboard.castTo'
type Target = { deviceId: string; name: string } | null
const listeners = new Set<() => void>()
let target: Target = read()

function read(): Target {
  try {
    const v = JSON.parse(localStorage.getItem(TARGET_KEY) ?? 'null')
    return v && typeof v.deviceId === 'string' ? { deviceId: v.deviceId, name: String(v.name ?? '') } : null
  } catch {
    return null
  }
}

export function setCastTarget(next: Target) {
  target = next
  try {
    if (next) localStorage.setItem(TARGET_KEY, JSON.stringify(next))
    else localStorage.removeItem(TARGET_KEY)
  } catch {
    /* private window: for this page only */
  }
  listeners.forEach((l) => l())
}

/** The screen chosen in the top bar, or null (this browser plays) */
export function useCastTarget(): Target {
  return useSyncExternalStore(
    useCallback((l: () => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }, []),
    () => target,
  )
}

/** What a media ref plays as (its prefix: a plugin's HLS h_, a live stream l_, else a file) */
export function refFormat(ref: string): 'file' | 'hls' | 'live' {
  return ref.startsWith('h_') ? 'hls' : ref.startsWith('l_') ? 'live' : 'file'
}

// ── who watches ─────────────────────────────────────────────────────────────

// the player's "Watch as" (pages/watch.tsx): a cast plays as that profile; none → the screen's own
export const WATCH_KEY = 'playpex.dashboard.watchAs'
export function watchAsProfile(): string | undefined {
  try {
    return localStorage.getItem(WATCH_KEY) || undefined
  } catch {
    return undefined
  }
}
