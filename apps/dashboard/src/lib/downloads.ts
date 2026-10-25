import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { API_PREFIX, api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { useEvent } from '@/lib/events'

// What the Downloads page and its pane share: the list (live through
// download.updated), the actions on one or many downloads, and the words for
// a download's state, kind and origin.

export type Download = Schemas['Download']
export type DownloadState = Download['state']

export const RUNNING: DownloadState[] = ['downloading', 'seeding', 'checking']

export function useDownloads() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['downloads'],
    queryFn: () => unwrap(api.GET('/downloads')),
    refetchInterval: 30_000,
  })
  // progress every 2 s per torrent: patch the cached list instead of refetching
  useEvent<Download>('download.updated', (e) => {
    client.setQueryData<Download[]>(['downloads'], (list) =>
      list?.some((d) => d.infoHash === e.data.infoHash) ? list.map((d) => (d.infoHash === e.data.infoHash ? e.data : d)) : list,
    )
  })
  return query
}

/** Starts, pauses, labels and removes downloads, one or many at once; one toast per action. */
export function useDownloadActions() {
  const client = useQueryClient()
  const refresh = () => {
    client.invalidateQueries({ queryKey: ['downloads'] })
    client.invalidateQueries({ queryKey: ['download'] })
  }
  const many = <T,>(hashes: string[], one: (hash: string) => Promise<T>) =>
    Promise.allSettled(hashes.map(one)).then((results) => {
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed.length === results.length) throw failed[0].reason
      return { done: results.length - failed.length, failed: failed.length }
    })
  const counted = (verb: string) => (r: { done: number; failed: number }) => {
    const what = r.done === 1 ? 'download' : 'downloads'
    toast.success(`${verb} ${r.done} ${what}${r.failed ? ` (${r.failed} failed)` : ''}`)
    refresh()
  }
  const fail = (err: unknown) => toast.error(errorMessage(err))
  const path = (infoHash: string) => ({ params: { path: { infoHash } } })
  return {
    start: useMutation({
      mutationFn: (hashes: string[]) => many(hashes, (h) => unwrap(api.POST('/downloads/{infoHash}/start', path(h)))),
      onSuccess: counted('Started'),
      onError: fail,
    }),
    pause: useMutation({
      mutationFn: (hashes: string[]) => many(hashes, (h) => unwrap(api.POST('/downloads/{infoHash}/pause', path(h)))),
      onSuccess: counted('Paused'),
      onError: fail,
    }),
    recheck: useMutation({
      mutationFn: (hashes: string[]) => many(hashes, (h) => unwrap(api.POST('/downloads/{infoHash}/recheck', path(h)))),
      onSuccess: counted('Checking the data of'),
      onError: fail,
    }),
    force: useMutation({
      mutationFn: ({ hashes, on }: { hashes: string[]; on: boolean }) =>
        many(hashes, (h) => unwrap(api.PATCH('/downloads/{infoHash}', { ...path(h), body: { force: on } }))),
      onSuccess: (r, { on }) => counted(on ? 'Force started' : 'Back under the queue’s rules:')(r),
      onError: fail,
    }),
    // one download to a place in the queue (1 = next to start)
    move: useMutation({
      mutationFn: ({ hash, position }: { hash: string; position: number }) =>
        unwrap(api.PATCH('/downloads/{infoHash}', { ...path(hash), body: { queuePosition: position } })),
      onSuccess: (d) => {
        toast.success(`Now #${d.queuePosition} in the queue`)
        refresh()
      },
      onError: fail,
    }),
    reannounce: useMutation({
      mutationFn: (hashes: string[]) => many(hashes, (h) => unwrap(api.POST('/downloads/{infoHash}/reannounce', path(h)))),
      onSuccess: counted('Announced again:'),
      onError: fail,
    }),
    // seeding goals and speed limits (null: the server's goal / no limit)
    rules: useMutation({
      mutationFn: ({ hashes, body }: { hashes: string[]; body: Rules }) =>
        many(hashes, (h) => unwrap(api.PATCH('/downloads/{infoHash}', { ...path(h), body }))),
      onSuccess: counted('Saved for'),
      onError: fail,
    }),
    label: useMutation({
      mutationFn: ({ hashes, label }: { hashes: string[]; label: string | null }) =>
        many(hashes, (h) => unwrap(api.PATCH('/downloads/{infoHash}', { ...path(h), body: { label } }))),
      onSuccess: (r, { label }) => counted(label ? `Labelled “${label}”:` : 'Took the label off')(r),
      onError: fail,
    }),
    remove: useMutation({
      mutationFn: ({ hashes, data }: { hashes: string[]; data: 'keep' | 'delete' }) =>
        many(hashes, (h) => unwrap(api.DELETE('/downloads/{infoHash}', { params: { path: { infoHash: h }, query: { data } } }))),
      onSuccess: (r, { data }) => {
        counted(data === 'delete' ? 'Removed with their files:' : 'Removed, files kept:')(r)
        client.invalidateQueries({ queryKey: ['storage'] })
      },
      onError: fail,
    }),
  }
}

export type Rules = { seedRatio?: number | null; seedMinutes?: number | null; downLimitKBps?: number | null; upLimitKBps?: number | null }

/** What the running engine can do (Overview `downloads.capabilities`): engine port v2 / v3 */
export function useEngineCaps() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => unwrap(api.GET('/admin/overview')), staleTime: 5000 })
  const caps = overview.data?.downloads.capabilities ?? {}
  return { engine: overview.data?.downloads.engine ?? null, can: (c: string) => !!caps[c] }
}

/** Its .torrent (an attachment: the admin's cookie goes with a plain link) */
export function torrentFileUrl(d: Download) {
  return `${API_PREFIX}/downloads/${d.infoHash}/torrent`
}

/** Connected, and the swarm from the last scrape: "3 (120)" */
export function swarmText(connected: number, inSwarm: number | null | undefined, running: boolean) {
  const swarm = inSwarm === null || inSwarm === undefined ? '' : ` (${inSwarm})`
  return running ? `${connected}${swarm}` : swarm ? swarm.trim() : '—'
}

/** A running (or waiting) download pauses; a stopped one starts. */
export function canPause(d: Download) {
  return RUNNING.includes(d.state) || d.state === 'queued'
}

export function canStart(d: Download) {
  return d.state === 'paused' || d.state === 'error' || (d.state === 'completed' && d.progress !== null && d.progress < 1)
}

/** The state in words: "Queued #2", "Checking 43 %", "Getting the file list" */
export function stateText(d: Download): string {
  switch (d.state) {
    case 'downloading':
      return d.name === null || d.sizeBytes === null ? 'Getting the file list' : d.forced ? 'Downloading (forced)' : 'Downloading'
    case 'seeding':
      return d.forced ? 'Seeding (forced)' : 'Seeding'
    case 'checking':
      return d.checking === null ? 'Checking' : `Checking ${Math.floor(d.checking * 100)} %`
    case 'queued':
      if (d.forced) return 'Forced, waiting'
      return d.queuePosition ? `Queued #${d.queuePosition}` : 'Queued'
    case 'paused':
      return 'Paused'
    case 'completed':
      return 'Completed'
    case 'error':
      return 'Error'
  }
}

export type Kind = 'movies' | 'shows' | 'other'

export const KINDS: { id: Kind; label: string }[] = [
  { id: 'movies', label: 'Movies' },
  { id: 'shows', label: 'Shows' },
  { id: 'other', label: 'Other' },
]

/** What a download is: the title a player named, else its name (SxxEyy / a year). */
export function kindOf(d: Download): Kind {
  if (d.title?.mediaType === 'movie') return 'movies'
  if (d.title?.mediaType === 'tv') return 'shows'
  const name = d.name ?? ''
  if (/\bS\d{1,2}(E\d{1,3})?\b|\bseason\b/i.test(name)) return 'shows'
  if (/\b(19|20)\d{2}\b/.test(name)) return 'movies'
  return 'other'
}

/** The title a player said it is: "Breaking Bad · S02E05" */
export function titleOf(d: Download): string | null {
  const t = d.title
  if (!t) return null
  const code = t.season ? ` · S${String(t.season).padStart(2, '0')}E${String(t.episode ?? 0).padStart(2, '0')}` : ''
  return (t.title ?? `TMDB ${t.mediaType} ${t.tmdbId}`) + (t.title?.includes(' · ') ? '' : code)
}

/** Device names by id (who added a download) */
export function useDeviceNames() {
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => unwrap(api.GET('/admin/devices')).then((r) => r.devices),
    staleTime: 60_000,
  })
  const names = new Map<string, string>()
  for (const d of devices.data ?? []) {
    names.set(d.id, d.name ?? d.id)
    if (d.clientDeviceId) names.set(d.clientDeviceId, d.name ?? d.clientDeviceId)
  }
  return (by: string | null) => {
    if (!by) return null
    if (by === 'admin') return 'you'
    if (by.startsWith('plugin:')) return `Plugin ${by.slice(7)}`
    if (by.startsWith('addr:')) return by.slice(5)
    return names.get(by) ?? by
  }
}

export function magnetOf(d: Download) {
  return `magnet:?xt=urn:btih:${d.infoHash}${d.name ? `&dn=${encodeURIComponent(d.name)}` : ''}`
}

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv)$/i

export function isVideo(path: string) {
  return VIDEO.test(path)
}

/** The video to play of a download: its largest selected one (a film, an episode), else its largest */
export function videoToPlay(files: { path: string; size: number; selected: boolean; ref: string; name: string }[] | null) {
  // a lone file is tried whatever its name (the server's probe says whether it plays)
  const videos = files?.length === 1 ? files : (files ?? []).filter((f) => isVideo(f.path))
  const pool = videos.some((f) => f.selected) ? videos.filter((f) => f.selected) : videos
  return pool.reduce<(typeof pool)[number] | null>((best, f) => (!best || f.size > best.size ? f : best), null)
}
