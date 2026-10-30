import { ApiError, unwrap, type Schemas } from '../http/api'
import type { ApiClient } from '../http/client'
import type { Details } from './catalog'

// Playing a title (docs/api/playback.md): its sources, the chosen one started,
// a torrent added and its file waited for, keepalives, releases and progress.
// Plain calls: the flow around them is core/playback.

export type PlaySource = Schemas['PlaySource']
export type PlaySources = Schemas['PlaySources']
export type PlayStart = Schemas['PlayStart']
export type Torrent = Schemas['Torrent']
export type TorrentFile = NonNullable<Torrent['files']>[number]
export type TorrentStats = Schemas['TorrentStats']
export type MediaTracks = Schemas['MediaTracks']
export type MediaTrack = Schemas['MediaTrack']
/** A plugin's marker in a file (POST /play/markers' answer) */
export type Marker = { plugin: string; kind: 'intro' | 'recap' | 'credits' | 'chapter'; start: number; end?: number; label?: string }
export type { Details }

/** What is being played: a movie, or an episode of a show (tmdbId and imdbId are the show's) */
export type PlayTitle = {
  mediaType: 'movie' | 'tv'
  tmdbId: number
  imdbId: string | null
  title: string
  year: number | null
  season?: number
  episode?: number
  episodeName?: string
  posterPath: string | null
  backdropPath: string | null
}

/** Where the profile stopped: the release and the second (docs/api/profiles.md) */
export type ResumePoint = {
  positionS: number
  durationS?: number
  fileId?: string | null
  infoHash?: string | null
  /** A torrent's path of the file */
  filePath?: string | null
  audioTrack?: string | null
  subtitleTrack?: string | null
}

/** What the player is told about a title from its catalog page (an episode: its numbers and name) */
export function playTitle(details: Details, episode?: { season: number; episode: number; name?: string }): PlayTitle {
  return {
    mediaType: details.mediaType,
    tmdbId: details.tmdbId,
    imdbId: details.imdbId,
    title: details.originalLanguage === 'en' ? (details.originalTitle ?? details.title) : details.title,
    year: details.year ? Number(details.year) : null,
    season: episode?.season,
    episode: episode?.episode,
    episodeName: episode?.name,
    posterPath: details.posterPath,
    backdropPath: details.backdropPath,
  }
}

/** "Breaking Bad · S02E05" */
export function label(title: PlayTitle): string {
  if (title.mediaType === 'tv' && title.season != null && title.episode != null) return `${title.title} · S${pad(title.season)}E${pad(title.episode)}`
  return title.title
}

const pad = (n: number) => String(n).padStart(2, '0')

export function findSources(client: ApiClient, title: PlayTitle, profileId: string): Promise<PlaySources> {
  const episode = title.mediaType === 'tv'
  return unwrap(
    client.api.POST('/play/sources', {
      body: {
        kind: episode ? 'episode' : 'movie',
        tmdbId: title.tmdbId,
        imdbId: title.imdbId,
        title: title.title,
        year: title.year,
        ...(episode ? { season: title.season, episode: title.episode } : {}),
        profileId,
      },
    }),
  )
}

/** POST /play/start; a server without it (404 on an old server) plays the source as listed */
export async function startSource(client: ApiClient, request: string, source: PlaySource, confirmed = false): Promise<PlayStart> {
  try {
    return await unwrap(client.api.POST('/play/start', { body: { request, source: source.id, ...(confirmed ? { confirmed } : {}) } }))
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && e.code == null) return { action: 'play', source }
    throw e
  }
}

export async function addTorrent(client: ApiClient, link: string): Promise<string> {
  return (await unwrap(client.api.POST('/torrents', { body: { link } }))).infoHash
}

/** GET /torrents/{infoHash} with what is played, so `chosen` names its file */
export function getTorrent(client: ApiClient, infoHash: string, title: PlayTitle, hint?: { index?: number | null; name?: string | null }): Promise<Torrent> {
  const query: Record<string, string | number> = {}
  if (title.mediaType === 'tv' && title.season != null && title.episode != null) {
    query.season = title.season
    query.episode = title.episode
  }
  if (hint?.index != null) query.fileIndex = hint.index
  if (hint?.name) query.fileName = hint.name
  return unwrap(client.api.GET('/torrents/{infoHash}', { params: { path: { infoHash }, query } }))
}

export function torrentStats(client: ApiClient, infoHash: string): Promise<TorrentStats> {
  return unwrap(client.api.GET('/torrents/{infoHash}/stats', { params: { path: { infoHash } } }))
}

/** Everything a player can switch for a file: its tracks, a torrent's separate audio / subtitle files, its other videos */
export function mediaTracks(client: ApiClient, ref: string): Promise<MediaTracks> {
  return unwrap(client.api.GET('/media/{ref}/tracks', { params: { path: { ref } } }))
}

export function keepalive(client: ApiClient, ref: string, body: Schemas['KeepaliveRequest']) {
  return client.api.POST('/media/{ref}/keepalive', { params: { path: { ref } }, body })
}

/** Releases this device's lease (also when playback never started); never deletes anything */
export async function release(client: ApiClient, lease: { ref?: string | null; infoHash?: string | null }): Promise<void> {
  try {
    if (lease.ref) await client.api.DELETE('/media/{ref}', { params: { path: { ref: lease.ref } } })
    else if (lease.infoHash) await client.api.DELETE('/torrents/{infoHash}', { params: { path: { infoHash: lease.infoHash } } })
  } catch {
    // the server is gone: nothing to release
  }
}

export type ProgressBody = Omit<Schemas['SaveProgressRequest'], 'title' | 'posterPath' | 'backdropPath' | 'season' | 'episode'>

export async function saveProgress(client: ApiClient, profileId: string, title: PlayTitle, body: ProgressBody): Promise<void> {
  await client.api
    .PUT('/profiles/{profileId}/progress/{mediaType}/{tmdbId}', {
      params: { path: { profileId, mediaType: title.mediaType, tmdbId: title.tmdbId } },
      body: {
        ...body,
        title: title.title,
        posterPath: title.posterPath,
        backdropPath: title.backdropPath,
        ...(title.mediaType === 'tv' ? { season: title.season, episode: title.episode } : {}),
      },
    })
    .catch(() => undefined)
}

/** Plugins' markers for the file: intro, recap, credits (docs/api/playback.md) */
export async function markers(client: ApiClient, title: PlayTitle, duration: number, file?: { name?: string; size?: number | null }): Promise<Marker[]> {
  const episode = title.mediaType === 'tv'
  const answer = await unwrap(
    client.api.POST('/play/markers', {
      body: {
        kind: episode ? 'episode' : 'movie',
        tmdbId: title.tmdbId,
        imdbId: title.imdbId,
        title: title.title,
        year: title.year,
        ...(episode ? { season: title.season, episode: title.episode } : {}),
        duration,
        ...(file?.name ? { fileName: file.name } : {}),
        ...(file?.size ? { size: file.size } : {}),
      },
    }),
  ).catch(() => ({ markers: [] as Marker[] }))
  return answer.markers
}

/** The library file of a ref (`f_<id>`), as a progress row names it */
export function fileIdOf(ref: string | null | undefined): string | null {
  return ref && ref.startsWith('f_') ? ref.slice(2) : null
}

export const GROUP_NAMES: Record<string, string> = { server: 'On this server', stream: 'Stream', torrent: 'Torrent' }

export function readinessText(readiness: string | undefined): string {
  switch (readiness) {
    case 'instant':
      return 'Plays now'
    case 'seconds':
      return 'Starts in seconds'
    case 'slow':
      return 'Few people sharing: may be slow'
    default:
      return ''
  }
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return ''
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB'
  return Math.round(bytes / 1e6) + ' MB'
}

/** The source to play without asking: the server's choice, else the first that plays, else the first */
export function bestSource(answer: PlaySources): PlaySource | null {
  const { sources } = answer
  return sources.find((s) => s.id === answer.policy.autoplay) ?? sources.find((s) => s.playable === 'yes' || s.playable === 'audio-converted') ?? sources[0] ?? null
}

/** Where the profile stopped in a title (an episode: its numbers) */
export async function getResume(client: ApiClient, profileId: string, title: PlayTitle): Promise<ResumePoint | null> {
  const query = title.mediaType === 'tv' && title.season != null && title.episode != null ? { season: title.season, episode: title.episode } : undefined
  const state = await unwrap(
    client.api.GET('/profiles/{profileId}/progress/{mediaType}/{tmdbId}', {
      params: { path: { profileId, mediaType: title.mediaType, tmdbId: title.tmdbId }, query },
    }),
  ).catch(() => null)
  return (state?.resume as ResumePoint | null | undefined) ?? null
}

export type Episode = Schemas['CatalogEpisode']

/**
 * The episode after `title`'s: the next one of its season, else the first of the following
 * season; null when there is none that has aired.
 */
export async function nextEpisode(client: ApiClient, title: PlayTitle, now = new Date()): Promise<{ title: PlayTitle; episode: Episode } | null> {
  if (title.mediaType !== 'tv' || title.season == null || title.episode == null) return null
  const season = (n: number) => unwrap(client.api.GET('/catalog/titles/tv/{tmdbId}/seasons/{season}', { params: { path: { tmdbId: title.tmdbId, season: n } } }))
  const current = await season(title.season)
  let found: { season: number; episode: Episode | undefined } = { season: title.season, episode: current.episodes.find((e) => e.episodeNumber === title.episode! + 1) }
  if (!found.episode) {
    const show = await unwrap(client.api.GET('/catalog/titles/{mediaType}/{tmdbId}', { params: { path: { mediaType: 'tv', tmdbId: title.tmdbId } } }))
    const following = (show.seasons ?? [])
      .map((s) => s.seasonNumber)
      .filter((n) => n > title.season!)
      .sort((a, b) => a - b)[0]
    if (following === undefined) return null
    found = { season: following, episode: (await season(following)).episodes[0] }
  }
  const episode = found.episode
  if (!episode?.airDate || new Date(episode.airDate) > now) return null
  return { title: { ...title, season: found.season, episode: episode.episodeNumber, episodeName: episode.name }, episode }
}
