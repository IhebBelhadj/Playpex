import { useMutation } from '@tanstack/react-query'
import { Download as DownloadIcon, Film, Link2, Play, Radio, Tv } from 'lucide-react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Spinner } from '@/components/common'
import { Button } from '@/components/ui/button'
import { api, API_PREFIX, errorMessage, unwrap, type Schemas } from '@/lib/api'
import type { DirectDownload } from '@/lib/direct'
import type { Download } from '@/lib/downloads'
import { bytes } from '@/lib/format'
import { tmdbImage } from '@/lib/media'
import { usePlayer } from '@/lib/player'
import type { LiveChannel } from '@/lib/search'

// Search › On this server (library titles, downloads, direct downloads whose
// name holds the words) and › Live TV (live plugins' channels).

type Entry = Schemas['ServerLibraryEntry']

export function ServerResults({ titles, downloads, direct, limit }: { titles: Entry[]; downloads: Download[]; direct: DirectDownload[]; limit?: number }) {
  const navigate = useNavigate()
  const player = usePlayer()
  const shown = (n: number) => (limit ? Math.min(n, limit) : n)
  return (
    <div className="space-y-4">
      {titles.length > 0 && (
        <ul className="flex flex-wrap gap-3">
          {titles.slice(0, shown(titles.length)).map((e) => {
            const poster = tmdbImage(e.posterPath, 'w185')
            return (
              <li key={`${e.mediaType}:${e.tmdbId}`}>
                <button
                  type="button"
                  onClick={() => navigate(`/library?title=${e.mediaType}:${e.tmdbId}`)}
                  className="group flex w-64 items-center gap-3 rounded-xl bg-card p-2.5 text-left transition-colors hover:bg-accent"
                >
                  <span className="flex h-16 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                    {poster ? <img src={poster} alt="" loading="lazy" className="size-full object-cover" /> : e.mediaType === 'tv' ? <Tv className="size-4" /> : <Film className="size-4" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{e.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[e.year, e.mediaType === 'tv' ? `${e.episodeCount ?? e.fileCount} episodes` : e.quality, 'in the library'].filter(Boolean).join(', ')}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {(downloads.length > 0 || direct.length > 0) && (
        <ul className="divide-y overflow-hidden rounded-xl bg-card">
          {downloads.slice(0, shown(downloads.length)).map((d) => (
            <li key={d.infoHash} className="flex items-center gap-3 px-3 py-2">
              <DownloadIcon className="size-4 shrink-0 text-muted-foreground" />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate(`/downloads?hash=${d.infoHash}`)}>
                <span className="block truncate text-sm font-medium">{d.name ?? d.infoHash}</span>
                <span className="block text-xs text-muted-foreground">
                  Torrent, {d.state}
                  {d.progress != null && d.progress < 1 ? `, ${Math.floor(d.progress * 100)} %` : ''}
                  {d.sizeBytes ? `, ${bytes(d.sizeBytes)}` : ''}
                </span>
              </button>
            </li>
          ))}
          {direct.slice(0, shown(direct.length)).map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2">
              <Link2 className="size-4 shrink-0 text-muted-foreground" />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate('/downloads?filter=direct')}>
                <span className="block truncate text-sm font-medium">{d.name}</span>
                <span className="block text-xs text-muted-foreground">
                  From {d.source.host}, {d.state}
                  {d.size ? `, ${bytes(d.size)}` : ''}
                </span>
              </button>
              {d.ref && (
                <Button variant="ghost" size="xs" onClick={() => player.play({ ref: d.ref!, title: d.name })}>
                  <Play /> Play
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A channel's logo: https as it is, else a path under the API prefix */
function logoUrl(logo: string | undefined) {
  return !logo ? null : /^https:\/\//.test(logo) ? logo : logo.startsWith('/') ? API_PREFIX + logo : null
}

export function LiveResults({ channels, names, limit }: { channels: LiveChannel[]; names: (plugin: string) => string; limit?: number }) {
  const player = usePlayer()
  const play = useMutation({
    mutationFn: (c: LiveChannel) =>
      unwrap(api.POST('/live/{pluginId}/channels/{channelId}/play', { params: { path: { pluginId: c.plugin, channelId: c.id } } })),
    onSuccess: (answer, c) => player.play({ ref: answer.source.ref, title: c.name, detail: `${names(c.plugin)}, channel ${c.number}` }),
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2">
      {channels.slice(0, limit ?? channels.length).map((c) => {
        const logo = logoUrl(c.logo)
        return (
          <li key={`${c.plugin}:${c.id}`}>
            <button
              type="button"
              disabled={play.isPending}
              onClick={() => play.mutate(c)}
              className="flex w-full items-center gap-3 rounded-xl bg-card p-2.5 text-left transition-colors hover:bg-accent"
              title={`Play ${c.name}`}
            >
              <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                {logo ? <img src={logo} alt="" loading="lazy" className="max-h-full max-w-full object-contain" /> : <Radio className="size-4 text-muted-foreground" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{c.name}</span>
                <span className="block truncate text-xs text-muted-foreground tabular-nums">{[c.number, c.group, names(c.plugin)].filter(Boolean).join(', ')}</span>
              </span>
              {play.isPending && play.variables === c ? <Spinner /> : <Play className="size-4 shrink-0 text-muted-foreground" />}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
