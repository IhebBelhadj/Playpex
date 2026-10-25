import { useQuery } from '@tanstack/react-query'
import { Download as DownloadIcon, Film, Play, Plus, Tv } from 'lucide-react'
import { useState } from 'react'
import { Loading, QueryError } from '@/components/common'
import { useSearchActions } from '@/components/search/parts'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { api, unwrap, type Schemas } from '@/lib/api'
import { bytes } from '@/lib/format'
import { episodeCode, tmdbImage } from '@/lib/media'
import type { CatalogTitle } from '@/lib/search'
import { cn } from '@/lib/utils'

// Search › Movies & shows: the catalog's titles as posters; one opens its
// sources (POST /play/sources: files on the server, downloads, plugins'
// streams and torrents, ranked), a show's for the episode chosen. Each source
// plays, downloads to the server or becomes a torrent download.

type PlaySource = Schemas['PlaySource']

/** Posters: a grid, or one strip that scrolls sideways (`strip`: the overview) */
export function TitlePosters({ titles, onOpen, limit, strip }: { titles: CatalogTitle[]; onOpen: (t: CatalogTitle) => void; limit?: number; strip?: boolean }) {
  return (
    <ul
      className={cn(
        strip
          ? 'flex snap-x gap-4 overflow-x-auto pb-2 [scrollbar-width:thin]'
          : 'grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-4 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(8rem,1fr))]',
      )}
    >
      {titles.slice(0, limit ?? titles.length).map((t) => {
        const poster = tmdbImage(t.posterPath, 'w342')
        return (
          <li key={`${t.mediaType}:${t.tmdbId}`} className={cn(strip && 'w-28 shrink-0 snap-start')}>
            <button type="button" onClick={() => onOpen(t)} className="group block w-full rounded-md text-left outline-none" title={t.title}>
              <span className="relative block aspect-2/3 overflow-hidden rounded-md bg-muted ring-1 ring-border transition-shadow group-hover:ring-2 group-hover:ring-primary group-focus-visible:ring-2 group-focus-visible:ring-primary">
                {poster ? (
                  <img src={poster} alt="" loading="lazy" className="size-full object-cover" />
                ) : (
                  <span className="flex size-full flex-col justify-end gap-1 p-3">
                    {t.mediaType === 'tv' ? <Tv className="size-4 text-muted-foreground" /> : <Film className="size-4 text-muted-foreground" />}
                    <span className="line-clamp-4 text-sm leading-snug font-medium">{t.title}</span>
                  </span>
                )}
              </span>
              <span className="mt-2 block truncate text-sm leading-tight font-medium">{t.title}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{[t.year, t.mediaType === 'tv' ? 'Show' : 'Movie'].filter(Boolean).join(', ')}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** A title's sources, as Play finds them */
export function TitleSourcesSheet({ title, onClose, onAdd }: { title: CatalogTitle | null; onClose: () => void; onAdd: (magnet: string, name: string) => void }) {
  const show = title?.mediaType === 'tv'
  const details = useQuery({
    queryKey: ['catalog-title', title?.mediaType, title?.tmdbId],
    enabled: !!title,
    queryFn: () => unwrap(api.GET('/catalog/titles/{mediaType}/{tmdbId}', { params: { path: { mediaType: title!.mediaType, tmdbId: title!.tmdbId } } })),
  })
  const seasons = ((details.data as { seasons?: Schemas['CatalogSeasonSummary'][] } | undefined)?.seasons ?? []).filter((s) => s.seasonNumber > 0)
  const [season, setSeason] = useState<number | null>(null)
  const [episode, setEpisode] = useState<number | null>(null)
  const chosenSeason = season ?? seasons[0]?.seasonNumber ?? null
  const episodes = useQuery({
    queryKey: ['catalog-season', title?.tmdbId, chosenSeason],
    enabled: !!title && show && chosenSeason !== null,
    queryFn: () => unwrap(api.GET('/catalog/titles/tv/{tmdbId}/seasons/{season}', { params: { path: { tmdbId: title!.tmdbId, season: chosenSeason! } } })),
  })
  const imdbId = (details.data as { imdbId?: string | null } | undefined)?.imdbId ?? null
  const ready = !!title && details.isSuccess && (!show || episode !== null)
  const sources = useQuery({
    queryKey: ['play-sources', title?.mediaType, title?.tmdbId, chosenSeason, episode],
    enabled: ready,
    staleTime: 60_000,
    queryFn: () =>
      unwrap(
        api.POST('/play/sources', {
          body: show
            ? { kind: 'episode', tmdbId: title!.tmdbId, imdbId, title: title!.title, season: chosenSeason!, episode: episode! }
            : { kind: 'movie', tmdbId: title!.tmdbId, imdbId, title: title!.title, year: title!.year ? parseInt(title!.year, 10) : null },
        }),
      ),
  })
  const backdrop = tmdbImage(title?.backdropPath, 'w780')
  const name = title ? title.title : ''
  const what = show && episode !== null && chosenSeason !== null ? `${name} ${episodeCode(chosenSeason, episode)}` : name

  return (
    <Sheet
      open={!!title}
      onOpenChange={(o) => {
        if (!o) {
          setSeason(null)
          setEpisode(null)
          onClose()
        }
      }}
    >
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:sm:max-w-2xl">
        <div className="relative">
          {backdrop ? <img src={backdrop} alt="" className="aspect-[21/9] w-full object-cover" /> : <div className="aspect-[4/1] w-full bg-muted" />}
          <div className="absolute inset-0 bg-linear-to-t from-popover via-popover/40 to-transparent" />
        </div>
        <SheetHeader className="-mt-14 px-5">
          <SheetTitle className="relative text-2xl leading-tight font-semibold tracking-tight">{name}</SheetTitle>
          <SheetDescription className="relative space-y-1">
            {title?.year && <span className="block text-foreground tabular-nums">{title.year}</span>}
            <span className="line-clamp-3">{title?.overview}</span>
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-5 pt-4 pb-8">
          {show && (
            <div className="space-y-3">
              {seasons.length > 0 && (
                <Select
                  value={chosenSeason !== null ? String(chosenSeason) : undefined}
                  onValueChange={(v) => {
                    setSeason(parseInt(v, 10))
                    setEpisode(null)
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Season" className="w-auto">
                    <SelectValue placeholder="Season" />
                  </SelectTrigger>
                  <SelectContent>
                    {seasons.map((s) => (
                      <SelectItem key={s.seasonNumber} value={String(s.seasonNumber)}>
                        {s.name || `Season ${s.seasonNumber}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {episodes.isPending ? (
                <Loading rows={2} />
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {(episodes.data?.episodes ?? []).map((e) => (
                    <li key={e.episodeNumber}>
                      <button
                        type="button"
                        onClick={() => setEpisode(e.episodeNumber)}
                        title={e.name}
                        aria-pressed={episode === e.episodeNumber}
                        className={cn(
                          'h-8 min-w-10 rounded-md border px-2 text-sm tabular-nums transition-colors',
                          episode === e.episodeNumber ? 'border-primary bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        {e.episodeNumber}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {episode === null && <p className="text-sm text-muted-foreground">Choose an episode to see where it can be played from.</p>}
            </div>
          )}
          {ready &&
            (sources.isPending ? (
              <p className="text-sm text-muted-foreground">Asking the library, the downloads and every source plugin…</p>
            ) : sources.error ? (
              <QueryError error={sources.error} title="Could not find its sources" />
            ) : (
              <SourceGroups answer={sources.data} what={what} onAdd={onAdd} />
            ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}

const GROUPS: Record<string, string> = { server: 'On this server', stream: 'Streams', torrent: 'Torrents' }

function SourceGroups({ answer, what, onAdd }: { answer: Schemas['PlaySources']; what: string; onAdd: (magnet: string, name: string) => void }) {
  const act = useSearchActions()
  if (!answer.sources.length) {
    return <p className="text-sm text-muted-foreground">Nothing found: no file on the server, no download, and no source plugin has it.</p>
  }
  const groups = answer.groups.map((g) => ({ ...g, sources: answer.sources.filter((s) => s.group === g.group) }))
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.group} className="space-y-2">
          <h3 className="text-sm font-medium">
            {GROUPS[g.group] ?? g.group} <span className="font-normal text-muted-foreground tabular-nums">{g.count}</span>
          </h3>
          <ul className="divide-y rounded-lg border">
            {g.sources.map((s) => (
              <SourceRow key={s.id} source={s} what={what} act={act} onAdd={onAdd} />
            ))}
          </ul>
        </section>
      ))}
      {answer.errors.length > 0 && <p className="text-xs text-muted-foreground">{answer.errors.map((e) => `${e.handler}: ${e.message}`).join('; ')}</p>}
    </div>
  )
}

function SourceRow({ source: s, what, act, onAdd }: { source: PlaySource; what: string; act: ReturnType<typeof useSearchActions>; onAdd: (magnet: string, name: string) => void }) {
  const facts = [s.quality, s.size ? bytes(s.size) : null, s.seeds != null ? `${s.seeds} seeds` : null, s.playable === 'no' ? 'won’t play in a browser' : null].filter(Boolean)
  const downloadable = s.type === 'plugin' && !!s.ref && s.format !== 'live'
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" title={s.label}>
          {s.label}
        </div>
        <div className="truncate text-xs text-muted-foreground">{[facts.join(', '), s.notes[0]].filter(Boolean).join('. ')}</div>
      </div>
      {s.type === 'torrent' ? (
        <>
          <Button variant="ghost" size="xs" onClick={() => s.magnet && onAdd(s.magnet, s.label)}>
            <Plus /> Add
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" size="xs" disabled={!s.ref} onClick={() => s.ref && act.play(s.ref, what, s.label)}>
            <Play /> Play
          </Button>
          {downloadable && (
            <Button variant="ghost" size="icon-xs" aria-label="Download to the server" title="Download to the server" onClick={() => act.download(s.ref!)}>
              <DownloadIcon />
            </Button>
          )}
        </>
      )}
    </li>
  )
}
