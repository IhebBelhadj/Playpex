import { router } from 'expo-router'
import type { PlayTitle, ResumePoint } from '../core/services/playback'

// Where a tap leads, for the screens' event handlers (never from render or a
// controller): the routes' params are strings, so the small things go as JSON.

/** The source sheet for a title; `resume` offers that release from where the profile stopped */
export function openPlay(title: PlayTitle, resume?: ResumePoint | null): void {
  router.push({ pathname: '/play', params: { title: JSON.stringify(title), ...(resume ? { resume: JSON.stringify(resume) } : {}) } })
}

/** The player for a session the source list made: it takes the list's place (Back returns to the title) */
export function openPlayer(sessionId: string): void {
  router.replace({ pathname: '/player', params: { session: sessionId } })
}

/** The player for a session made elsewhere (a plugin's play effect): over the current screen */
export function pushPlayer(sessionId: string): void {
  router.push({ pathname: '/player', params: { session: sessionId } })
}

/** The catalogue to wander through: a list (popular, trending…) or a genre */
export function openBrowse(mediaType: 'movie' | 'tv', from: { list?: string; genre?: number; label?: string }): void {
  router.push({
    pathname: '/browse/[mediaType]',
    params: { mediaType, ...(from.list ? { list: from.list } : {}), ...(from.genre != null ? { genre: String(from.genre) } : {}), ...(from.label ? { label: from.label } : {}) },
  })
}

/** Find releases: for a title (plays as it), or for keywords */
export function openReleases(from: { title?: PlayTitle; kind?: 'movie' | 'tv'; q?: string }): void {
  router.push({
    pathname: '/releases',
    params: { ...(from.title ? { title: JSON.stringify(from.title) } : {}), ...(from.kind ? { kind: from.kind } : {}), ...(from.q ? { q: from.q } : {}) },
  })
}
