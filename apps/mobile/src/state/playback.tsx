import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PlayerController } from '../core/player/controller'
import { PlayerExtras } from '../core/player/extras'
import { changeSetting } from '../core/services/settings'
import { PlayRequest } from '../core/playback/request'
import { PlaybackSession } from '../core/playback/session'
import { mediaTracks, type PlaySource, type PlayTitle, type ResumePoint } from '../core/services/playback'
import { playSourceOf, type Found } from '../core/services/releases'
import { MpvPlayer, MpvSurface } from '../native/mpvPlayer'
import { useApp, useClient, useProfile } from './app'
import { useOwned } from './hooks'
import { openPlayer, pushPlayer } from './navigation'
import { keys, queries } from './queries'
import type { PlayerPreferences } from '../core/player/preferences'

// Playback's controllers for the screens: the source sheet's request, the
// player's session (taken from the registry) and its controller with the video.

/** The Play sheet's request: sources load while it is open; nothing starts until choose() */
export function usePlayRequest(title: PlayTitle, resume: ResumePoint | null): PlayRequest {
  const client = useClient()
  const profile = useProfile()
  const { playbacks } = useApp()
  return useOwned(() => new PlayRequest({ client, profileId: profile.id, title, resume, registry: playbacks }))
}

/** The session the Play sheet made for this player (taken once: the player owns it) */
export function useTakenSession(id: string): PlaybackSession | null {
  const { playbacks } = useApp()
  const [session] = useState(() => playbacks.take(id))
  return session
}

export type Player = { controller: PlayerController; extras: PlayerExtras; Video: () => React.JSX.Element }

/**
 * The player for a session: mpv, its controller (which runs the session while the screen
 * is mounted) and the video surface to draw. Leaving marks the profile's lists stale.
 */
export function usePlayer(session: PlaybackSession): Player {
  const queryClient = useQueryClient()
  const client = useClient()
  const profile = useProfile()
  const [mpv] = useState(() => new MpvPlayer())
  const controller = useOwned(
    () =>
      new PlayerController(
        session,
        mpv,
        () => {
          // What the profile watched changed: Continue watching, progress marks
          void queryClient.invalidateQueries({ queryKey: ['library'] })
          void queryClient.invalidateQueries({ queryKey: ['progress'] })
        },
        // The settings (cached since the Settings page or the last play; at most a request)
        () => queryClient.ensureQueryData(queries.settings(client, profile.id)).then(preferencesOf),
        (ref) => mediaTracks(client, ref),
      ),
  )
  const { playbacks } = useApp()
  const extras = useOwned(
    () =>
      new PlayerExtras(controller, mpv, {
        client,
        profileId: profile.id,
        registry: playbacks,
        subtitleProvider: () =>
          queryClient.ensureQueryData(queries.settings(client, profile.id)).then((s) => (typeof s.profile?.['subtitles.provider'] === 'string' ? s.profile['subtitles.provider'] : null)),
        autoplayNext: () => queryClient.ensureQueryData(queries.settings(client, profile.id)).then((s) => s.profile?.['player.autoplayNext'] !== false),
        onNext: (sessionId) => openPlayer(sessionId),
        rememberSubtitleProvider: (provider) => {
          void changeSetting(client, profile.id, 'subtitles.provider', provider).then(() => queryClient.invalidateQueries({ queryKey: keys.settings(profile.id) }))
        },
      }),
  )
  const [Video] = useState(() => {
    function Video() {
      return <MpvSurface player={mpv} />
    }
    return Video
  })
  return { controller, extras, Video }
}

/** A plugin's play effect (docs/api/plugins.md): its first source plays at once, in the player */
export function usePlayEffect(): (title: PlayTitle, source: PlaySource, tracking: 'full' | 'none') => void {
  const client = useClient()
  const profile = useProfile()
  const { playbacks } = useApp()
  return (title, source, tracking) => {
    const session = new PlaybackSession({ client, profileId: profile.id, title, source, startAt: 0, tracking })
    pushPlayer(playbacks.add(session))
  }
}

/** A result of Find releases, in the player: as the title it was searched for, else with nothing saved */
export function usePlayFound(): (found: Found, title: PlayTitle | null) => void {
  const client = useClient()
  const profile = useProfile()
  const { playbacks } = useApp()
  return (found, title) => {
    const playing: PlayTitle = title
      ? {
          ...title,
          // A release that names its episode plays that one (a pack: the server picks its file)
          ...(title.mediaType === 'tv' && found.season != null && found.episode != null ? { season: found.season, episode: found.episode } : {}),
        }
      : { mediaType: 'movie', tmdbId: 0, imdbId: null, title: found.title, year: found.year, posterPath: null, backdropPath: null }
    const session = new PlaybackSession({ client, profileId: profile.id, title: playing, source: playSourceOf(found), startAt: 0, tracking: title ? 'full' : 'none' })
    pushPlayer(playbacks.add(session))
  }
}

function preferencesOf(settings: { device: Record<string, unknown>; profile: Record<string, unknown> | null }): PlayerPreferences {
  const p = settings.profile ?? {}
  return {
    audioLanguage: typeof p['player.audioLanguage'] === 'string' ? p['player.audioLanguage'] : 'original',
    subtitleLanguage: typeof p['player.subtitleLanguage'] === 'string' ? p['player.subtitleLanguage'] : 'off',
    subtitleForcedOnly: p['player.subtitleForcedOnly'] === true,
    subtitleSize: (settings.device['subtitles.size'] as PlayerPreferences['subtitleSize']) ?? 'medium',
  }
}
