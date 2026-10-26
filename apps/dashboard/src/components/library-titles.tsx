import { useQuery } from '@tanstack/react-query'
import { Clapperboard, ExternalLink, Film, FolderOpen, Info, Play, Search, Tv } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Empty, Loading, QueryError } from '@/components/common'
import { fileName, quality, type LibraryFile } from '@/components/library-common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { api, unwrap, type Schemas } from '@/lib/api'
import { ago, bytes } from '@/lib/format'
import { episodeCode, tmdbImage } from '@/lib/media'
import { placeOf, usePlayer } from '@/lib/player'
import { cn } from '@/lib/utils'

// The Library's index (?view=titles): every movie and show the server holds,
// as posters A to Z ("The Thing" under T: articles don't count) with a rail of
// letters to jump, or newest first. A title opens its sheet
// (?title=movie:949): its files, a show's by season and episode, to play.

type Entry = Schemas['ServerLibraryEntry']
type Kind = 'all' | 'movie' | 'tv'
type Order = 'az' | 'new'

const ARTICLES = /^(the|a|an|le|la|les|l'|el|los|las|der|die|das)\s+/i

/** What a title is filed under: its name without a leading article */
function sortName(title: string) {
  return title.replace(ARTICLES, '').replace(/^[^\p{L}\p{N}]+/u, '')
}

function letterOf(title: string) {
  const first = sortName(title).charAt(0).toLocaleUpperCase()
  return /\p{L}/u.test(first) ? first.normalize('NFD').charAt(0) : '#'
}

const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']

export const titleKey = (e: { mediaType: string; tmdbId: number }) => `${e.mediaType}:${e.tmdbId}`

export function useLibraryHome() {
  return useQuery({ queryKey: ['library-home'], queryFn: () => unwrap(api.GET('/library/home')), staleTime: 30_000 })
}

export function TitlesIndex({ onOpen, onPlace }: { onOpen: (key: string) => void; onPlace: (place: string) => void }) {
  const home = useLibraryHome()
  const [kind, setKind] = useState<Kind>('all')
  const [order, setOrder] = useState<Order>('az')
  const [filter, setFilter] = useState('')

  const shown = useMemo(() => {
    const all = [...(kind !== 'tv' ? (home.data?.movies ?? []) : []), ...(kind !== 'movie' ? (home.data?.shows ?? []) : [])]
    const words = filter.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const kept = words.length ? all.filter((e) => words.every((w) => e.title.toLocaleLowerCase().includes(w))) : all
    return order === 'new'
      ? kept.sort((a, b) => b.addedAt.localeCompare(a.addedAt))
      : kept.sort((a, b) => sortName(a.title).localeCompare(sortName(b.title), undefined, { sensitivity: 'base', numeric: true }) || (a.year ?? 0) - (b.year ?? 0))
  }, [home.data, kind, order, filter])

  if (home.isPending) return <Loading rows={4} />
  if (home.error) return <QueryError error={home.error} title="Could not load the titles" />

  const movies = home.data.movies.length
  const shows = home.data.shows.length
  const other = home.data.other

  if (!movies && !shows) {
    return (
      <Empty icon={<Clapperboard />} title="No titles yet">
        When a scan matches files to movies and shows on TMDB, they show here as posters.
        {other.count > 0 ? ` ${other.count} videos aren’t matched to a title: find them in their places.` : ''}
      </Empty>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={kind}
          onChange={setKind}
          label="What"
          options={[
            { id: 'all', label: 'Everything', count: movies + shows },
            { id: 'movie', label: 'Movies', count: movies },
            { id: 'tv', label: 'Shows', count: shows },
          ]}
        />
        <Segmented
          value={order}
          onChange={setOrder}
          label="Order"
          options={[
            { id: 'az', label: 'A to Z' },
            { id: 'new', label: 'Newest' },
          ]}
        />
        <div className="relative min-w-48 flex-1 lg:ml-auto lg:w-64 lg:flex-none">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a title" aria-label="Find a title" className="pl-9" />
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty icon={<Search />} title={`No title with “${filter}”`}>
          Every word you type must be in its name.
        </Empty>
      ) : order === 'az' ? (
        <LetterIndex entries={shown} onOpen={onOpen} />
      ) : (
        <PosterGrid entries={shown} onOpen={onOpen} newest />
      )}

      {other.count > 0 && (
        <section className="space-y-2 border-t pt-5">
          <h2 className="text-sm font-medium">Other videos</h2>
          <p className="text-sm text-muted-foreground">
            {other.count} {other.count === 1 ? 'video isn’t' : 'videos aren’t'} a movie or an episode Playpex knows.
          </p>
          <div className="flex flex-wrap gap-2">
            {other.folders.map((f) => (
              <Button key={f.id} variant="outline" size="sm" onClick={() => onPlace(`folder:${f.id}`)}>
                <FolderOpen /> {f.name} <span className="text-muted-foreground tabular-nums">{f.count}</span>
              </Button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: { id: T; label: string; count?: number }[]
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-full px-3 py-1 text-sm transition-colors',
            value === o.id ? 'bg-card font-medium text-foreground dark:bg-input' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** Below this many titles the list is short enough to scan without letters */
const RAIL_FROM = 24

// A to Z: one unbroken grid (no sections: a letter with two titles leaves no
// hole), and beside it a slim rail of the letters titles are filed under, to
// jump; the letter the view is in stays lit, like a phone's contacts.
function LetterIndex({ entries, onOpen }: { entries: Entry[]; onOpen: (key: string) => void }) {
  const firsts = useMemo(() => {
    // the first title of each letter, to jump to
    const map = new Map<string, string>()
    const seen = new Set<string>()
    for (const e of entries) {
      const l = letterOf(e.title)
      if (!seen.has(l)) map.set(titleKey(e), l)
      seen.add(l)
    }
    return map
  }, [entries])
  const letters = useMemo(() => [...new Set(firsts.values())].sort((a, b) => LETTERS.indexOf(a) - LETTERS.indexOf(b) || a.localeCompare(b)), [firsts])
  const rail = entries.length >= RAIL_FROM && letters.length > 1
  const [current, setCurrent] = useState(letters[0])

  useEffect(() => {
    if (!rail) return
    let frame = 0
    const update = () => {
      frame = 0
      let at = letters[0]
      for (const l of letters) {
        const el = document.getElementById(`letter-${l}`)
        if (el && el.getBoundingClientRect().top <= 120) at = l
      }
      setCurrent(at)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [rail, letters])

  const jump = (l: string) => {
    setCurrent(l)
    document.getElementById(`letter-${l}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className={cn(rail && 'md:grid md:grid-cols-[minmax(0,1fr)_1.75rem] md:gap-4')}>
      <PosterGrid entries={entries} onOpen={onOpen} anchors={firsts} />
      {rail && (
        <nav aria-label="Jump to a letter" className="sticky top-20 hidden max-h-[calc(100svh-6rem)] flex-col items-center self-start rounded-full bg-muted/50 py-1.5 md:flex">
          {letters.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => jump(l)}
              aria-label={l === '#' ? 'Numbers and signs' : l}
              aria-current={current === l ? 'location' : undefined}
              className={cn(
                'flex min-h-0 w-6 max-h-5 flex-1 items-center justify-center rounded-full text-[11px] leading-none font-medium tabular-nums transition-colors',
                current === l ? 'bg-gold text-gold-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {l}
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}

function PosterGrid({ entries, onOpen, newest, anchors }: { entries: Entry[]; onOpen: (key: string) => void; newest?: boolean; anchors?: Map<string, string> }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]">
      {entries.map((e) => (
        <li key={titleKey(e)} id={anchors?.has(titleKey(e)) ? `letter-${anchors.get(titleKey(e))}` : undefined} className="scroll-mt-16 md:scroll-mt-4">
          <PosterCard entry={e} onOpen={() => onOpen(titleKey(e))} newest={newest} />
        </li>
      ))}
    </ul>
  )
}

function PosterCard({ entry: e, onOpen, newest }: { entry: Entry; onOpen: () => void; newest?: boolean }) {
  const poster = tmdbImage(e.posterPath, 'w342')
  const facts = [
    e.year,
    e.mediaType === 'tv' ? `${e.episodeCount ?? e.fileCount} ${(e.episodeCount ?? e.fileCount) === 1 ? 'episode' : 'episodes'}` : e.quality,
  ].filter(Boolean)
  return (
    <button type="button" onClick={onOpen} className="group block w-full rounded-md text-left outline-none" title={e.title}>
      <span className="relative block aspect-2/3 overflow-hidden rounded-md bg-muted ring-1 ring-border transition-shadow group-hover:ring-2 group-hover:ring-primary group-focus-visible:ring-2 group-focus-visible:ring-primary">
        {poster ? (
          <img src={poster} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <span className="flex size-full flex-col justify-end gap-1 p-3">
            {e.mediaType === 'tv' ? <Tv className="size-4 text-muted-foreground" /> : <Film className="size-4 text-muted-foreground" />}
            <span className="line-clamp-4 text-sm leading-snug font-medium">{e.title}</span>
          </span>
        )}
      </span>
      <span className="mt-2 block truncate text-sm leading-tight font-medium">{e.title}</span>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{newest ? `Added ${ago(e.addedAt)}` : facts.join(', ')}</span>
    </button>
  )
}

// ── one title: its files ─────────────────────────────────────────────────────

export function TitleSheet({ titleId, onClose, onOpenFile }: { titleId: string | null; onClose: () => void; onOpenFile: (fileId: string) => void }) {
  const home = useLibraryHome()
  const player = usePlayer()
  const navigate = useNavigate()
  const entry = [...(home.data?.movies ?? []), ...(home.data?.shows ?? [])].find((e) => titleKey(e) === titleId) ?? null
  const files = useQuery({
    queryKey: ['library-title', titleId],
    enabled: !!titleId,
    queryFn: () => unwrap(api.GET('/admin/library/files', { params: { query: { title: titleId!, limit: 500 } } })),
  })
  const list = (files.data?.files ?? []).filter((f) => f.state !== 'ignored')
  const show = titleId?.startsWith('tv:')
  const name = entry?.title ?? list[0]?.item?.title ?? 'Title'
  const backdrop = tmdbImage(entry?.backdropPath, 'w780')
  const poster = tmdbImage(entry?.posterPath ?? list[0]?.item?.artwork?.posterPath, 'w185')
  const [mediaType, tmdbId] = (titleId ?? ':').split(':')

  const playFile = (f: LibraryFile) =>
    player.play({
      ref: f.ref,
      title: f.item?.kind === 'episode' ? `${name} · ${episodeCode(f.item.season, f.item.episode)}${f.item.episodeTitle ? ` · ${f.item.episodeTitle}` : ''}` : name,
      detail: fileName(f.relPath),
      ...placeOf(f.folderId, f.relPath),
    })
  const showFolder = (f: LibraryFile) => {
    const at = placeOf(f.folderId, f.relPath)
    onClose()
    navigate(`/library?place=${encodeURIComponent(at.place)}${at.dir ? `&path=${encodeURIComponent(at.dir)}` : ''}`)
  }

  // a show's files by season, then episode
  const seasons = useMemo(() => {
    if (!show) return []
    const map = new Map<number, LibraryFile[]>()
    for (const f of list) {
      const s = f.item?.season ?? 0
      map.set(s, [...(map.get(s) ?? []), f])
    }
    return [...map.entries()]
      .sort(([a], [b]) => a - b)
      .map(([season, eps]) => [season, eps.sort((a, b) => (a.item?.episode ?? 0) - (b.item?.episode ?? 0) || a.relPath.localeCompare(b.relPath))] as const)
  }, [list, show])

  const row = (f: LibraryFile, label: ReactNode) => (
    <li key={f.id} className="group/file flex items-center gap-2 py-2">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenFile(f.id)} title="Details and match">
        <span className="block truncate text-sm">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {[quality(f), bytes(f.size), f.state === 'missing' ? 'missing from the disk' : null].filter(Boolean).join(', ')}
        </span>
      </button>
      <Button variant="ghost" size="icon-sm" aria-label="Show in its folder" title="Show in its folder" className="opacity-60 group-hover/file:opacity-100" onClick={() => showFolder(f)}>
        <FolderOpen />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Details and match" title="Details and match" className="opacity-60 group-hover/file:opacity-100" onClick={() => onOpenFile(f.id)}>
        <Info />
      </Button>
      <Button variant="secondary" size="icon-sm" aria-label="Play" title="Play" disabled={f.state === 'missing'} onClick={() => playFile(f)}>
        <Play />
      </Button>
    </li>
  )

  return (
    <Sheet open={!!titleId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:sm:max-w-xl">
        <div className="relative">
          {backdrop ? <img src={backdrop} alt="" className="aspect-video w-full object-cover" /> : <div className="aspect-[3/1] w-full bg-muted" />}
          <div className="absolute inset-0 bg-linear-to-t from-popover via-popover/40 to-transparent" />
        </div>
        <SheetHeader className="-mt-20 flex-row items-end gap-4 px-5">
          {poster && <img src={poster} alt="" className="relative aspect-2/3 w-24 shrink-0 rounded-md object-cover ring-1 ring-border" />}
          <div className="relative min-w-0 pb-1">
            <SheetTitle className="text-2xl leading-tight font-semibold tracking-tight">{name}</SheetTitle>
            <SheetDescription>
              {[entry?.year, show ? `${entry?.episodeCount ?? list.length} episodes, ${entry?.seasonCount ?? seasons.length} ${(entry?.seasonCount ?? seasons.length) === 1 ? 'season' : 'seasons'}` : `${list.length} ${list.length === 1 ? 'file' : 'files'}`]
                .filter(Boolean)
                .join(', ')}
            </SheetDescription>
          </div>
        </SheetHeader>
        <div className="space-y-6 px-5 pt-5 pb-8">
          {files.isPending ? (
            <Loading rows={3} />
          ) : files.error ? (
            <QueryError error={files.error} title="Could not load its files" />
          ) : show ? (
            seasons.map(([season, eps]) => (
              <section key={season} className="space-y-1">
                <h3 className="text-sm font-medium">{season === 0 ? 'Specials' : `Season ${season}`}</h3>
                <ul className="divide-y">
                  {eps.map((f) =>
                    row(
                      f,
                      <>
                        <span className="mr-2 text-muted-foreground tabular-nums">{String(f.item?.episode ?? 0).padStart(2, '0')}</span>
                        {f.item?.episodeTitle ?? fileName(f.relPath)}
                      </>,
                    ),
                  )}
                </ul>
              </section>
            ))
          ) : (
            <ul className="divide-y">{list.map((f) => row(f, fileName(f.relPath)))}</ul>
          )}
          {tmdbId && (
            <a
              className="inline-flex items-center gap-1 text-xs underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
              href={`https://www.themoviedb.org/${mediaType}/${tmdbId}`}
              target="_blank"
              rel="noreferrer"
            >
              On TMDB <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
