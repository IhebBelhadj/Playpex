import { Puzzle, Search, SearchX, X } from 'lucide-react'
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AddDownloadDialog } from '@/components/add-download'
import { Empty, Spinner } from '@/components/common'
import { useLibraryHome } from '@/components/library-titles'
import { RAIL_WIDTH, useIsDesktop } from '@/components/rail'
import { LinkView } from '@/components/search/link'
import { StreamRows, TorrentRows } from '@/components/search/offers'
import { FilterBar, keep, NO_FILTERS, sameSource, SectionHead, SourcesSummary, type Filters } from '@/components/search/parts'
import { LiveResults, ServerResults } from '@/components/search/server'
import { TitlePosters, TitleSourcesSheet } from '@/components/search/titles'
import { TorrentTable } from '@/components/search/torrents'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useDirectDownloads } from '@/lib/direct'
import { useDownloads } from '@/lib/downloads'
import {
  holds,
  isLink,
  useCatalogSearch,
  useLiveSearch,
  useSearchSources,
  useStreamSearch,
  useTorrentSearch,
  type CatalogTitle,
  type Release,
  type SearchKind,
  type SourceState,
} from '@/lib/search'
import { cn } from '@/lib/utils'

// /search (docs/search-plan.md): one field for everything the server reaches
// (?q=&kind=all|movie|tv&view=). Every source answers on its own: this
// server (library titles, downloads), the catalog (movies and shows, their
// sources from the play pipeline), plugins' streams and files (sources.search),
// the release providers' torrents, live plugins' channels. The sources' line
// says how each is doing (a click hides one); the rail picks a group (All:
// the best of each) and narrows streams and torrents (close matches first:
// sites answer loosely, the server marks names that hold every word).
// A link in the field (a page, a video, a playlist, a magnet, a .torrent) is
// read by the server instead: what it is, what it links to, each with its actions.
// Layout (2026-10-26): the field, one sentence on the sources (a popover lists
// them), tabs for the groups that found something, Top results led by what is
// on this server and the titles, then "Watch now" and "Download" side by side.

type View = 'all' | 'server' | 'titles' | 'streams' | 'torrents' | 'live'
const VIEWS: View[] = ['all', 'server', 'titles', 'streams', 'torrents', 'live']
const KINDS: { id: SearchKind; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'movie', label: 'Movies' },
  { id: 'tv', label: 'Shows' },
]

// ── recent searches (this browser only: a convenience) ──────────────────────

const RECENT_KEY = 'playpex.dashboard.recentSearches'
type Recent = { q: string; kind: SearchKind }

function loadRecent(): Recent[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(list)
      ? list.filter((r) => typeof r?.q === 'string').map((r) => ({ q: r.q, kind: r.kind === 'movie' || r.kind === 'tv' ? r.kind : 'all' })).slice(0, 8)
      : []
  } catch {
    return []
  }
}

function saveRecent(list: Recent[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)))
  } catch {
    // private window, storage off: only the list is lost
  }
}

// ── the page ────────────────────────────────────────────────────────────────

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const asked = params.get('kind')
  const kind: SearchKind = asked === 'movie' || asked === 'tv' ? asked : 'all'
  const q = (params.get('q') ?? '').trim().slice(0, 4096)
  const view: View = VIEWS.includes(params.get('view') as View) ? (params.get('view') as View) : 'all'

  const search = (next: Recent) => {
    const query = next.q.trim()
    if (query && !isLink(query)) {
      saveRecent([next, ...loadRecent().filter((r) => !(r.q.toLowerCase() === query.toLowerCase() && r.kind === next.kind))])
    }
    const p: Record<string, string> = {}
    if (query) p.q = query
    if (next.kind !== 'all') p.kind = next.kind
    setParams(p)
  }
  const setView = (v: View) => {
    const p = new URLSearchParams(params)
    if (v === 'all') p.delete('view')
    else p.set('view', v)
    setParams(p)
  }

  // a new search (or kind) starts with no filters
  return <SearchView key={`${kind}\n${q}`} kind={kind} q={q} view={view} onSearch={search} onView={setView} />
}

function SearchView({ kind, q, view, onSearch, onView }: { kind: SearchKind; q: string; view: View; onSearch: (r: Recent) => void; onView: (v: View) => void }) {
  const [text, setText] = useState(q)
  const [recent, setRecent] = useState(loadRecent)
  const [torrentFilters, setTorrentFilters] = useState<Filters>(NO_FILTERS)
  const [streamFilters, setStreamFilters] = useState<Filters>(NO_FILTERS)
  const [off, setOff] = useState<string[]>([])
  const [adding, setAdding] = useState<{ link: string; name: string } | null>(null)
  const [titleOpen, setTitleOpen] = useState<CatalogTitle | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const railed = useIsDesktop(RAIL_WIDTH)

  const link = isLink(q)
  const words = link ? '' : q.slice(0, 100)
  const sources = useSearchSources(kind)
  const torrents = useTorrentSearch(kind, words, sources.torrents)
  const streams = useStreamSearch(kind, words, sources.streams)
  const titles = useCatalogSearch(kind, words)
  const live = useLiveSearch(words, sources.live)
  const home = useLibraryHome()
  const downloads = useDownloads()
  const direct = useDirectDownloads()

  const names = useMemo(() => {
    const all = new Map<string, string>()
    for (const s of [...sources.torrents, ...sources.streams]) all.set(s.id, s.name)
    for (const l of sources.live) all.set(l.plugin, l.name)
    return all
  }, [sources.torrents, sources.streams, sources.live])
  const nameOf = (provider: string) => names.get(provider) ?? names.get(`plugin:${provider}`) ?? provider
  const shown = <T extends { provider: string }>(list: T[]) => list.filter((t) => !off.some((id) => sameSource(t.provider, id)))

  // what came back, per group
  const kept = useMemo(() => new Set((downloads.data ?? []).map((d) => d.infoHash.toLowerCase())), [downloads.data])
  const labels = useMemo(() => [...new Set((downloads.data ?? []).map((d) => d.label).filter((l): l is string => !!l))].sort(), [downloads.data])
  const allTorrents = shown(torrents.items)
  // a plugin that is both (OpenScrapers, The Crew): "<name> files", "<name> torrents"; its torrents among its
  // files are the ones its torrent search lists too, so Streams keeps only what plays without a torrent
  const both = new Set(sources.streams.filter((s) => sources.torrents.some((t) => t.id === s.id)).map((s) => s.id))
  const allStreams = shown(streams.items).filter((x) => !(x.kind === 'torrent' && [...both].some((id) => sameSource(x.provider, id))))
  const torrentList = allTorrents.filter((t) => keep(t, torrentFilters)).sort((a, b) => b.seeds - a.seeds)
  const streamList = allStreams.filter((s) => keep(s, streamFilters))
  const channels = live.items.filter((c) => !off.includes(c.plugin))
  const catalog = titles.data ?? []
  const server = {
    titles: words
      ? [...(kind !== 'tv' ? (home.data?.movies ?? []) : []), ...(kind !== 'movie' ? (home.data?.shows ?? []) : [])].filter((e) => holds(e.title, words))
      : [],
    downloads: words ? (downloads.data ?? []).filter((d) => d.name && holds(d.name, words)) : [],
    direct: words ? (direct.data ?? []).filter((d) => holds(d.name, words)) : [],
  }
  const serverCount = server.titles.length + server.downloads.length + server.direct.length
  const close = <T extends { matches?: boolean }>(list: T[]) => list.filter((t) => t.matches !== false).length
  // what plays right away (a plugin's torrents among its files belong with the torrents)
  const watchable = streamList.filter((x) => x.kind !== 'torrent' && x.matches !== false)

  const states: SourceState[] = [
    ...sources.streams.map((s) =>
      stateOf({ id: s.id, name: both.has(s.id) ? `${s.name} files` : s.name, group: 'streams' as const }, streams.states.find((x) => x.id === s.id), !!words),
    ),
    ...sources.torrents.map((s) =>
      stateOf({ id: s.id, name: both.has(s.id) ? `${s.name} torrents` : s.name, group: 'torrents' as const }, torrents.states.find((x) => x.id === s.id), !!words),
    ),
    ...sources.live.map((l) => stateOf({ id: l.plugin, name: l.name, group: 'live' as const }, live.states.find((x) => x.id === l.plugin), !!words)),
  ]
  const searching = titles.isFetching || torrents.searching || streams.searching || live.searching
  const counts: Record<View, number> = {
    all: 0,
    server: serverCount,
    titles: catalog.length,
    streams: close(allStreams),
    torrents: close(allTorrents),
    live: channels.length,
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    onSearch({ q: text, kind })
    setRecent(loadRecent())
  }
  const addTorrent = (t: Release) => setAdding({ link: t.magnet, name: t.name })
  const noPlugins = !sources.pending && !sources.torrents.length && !sources.streams.length

  // a group gets a tab when it can answer; once the search is done, only if it found something
  const groups: { id: View; label: string; shown: boolean }[] = [
    { id: 'all', label: 'Top results', shown: true },
    { id: 'titles', label: 'Movies & shows', shown: true },
    { id: 'streams', label: 'Streams', shown: sources.streams.length > 0 },
    { id: 'torrents', label: 'Torrents', shown: sources.torrents.length > 0 },
    { id: 'server', label: 'On this server', shown: true },
    { id: 'live', label: 'Live TV', shown: sources.live.length > 0 },
  ]
  const tabs = groups.filter((g) => g.shown && (g.id === 'all' || g.id === view || counts[g.id] > 0 || searching))
  const fixed: SourceState[] = [
    { source: { id: 'server', name: 'This server', group: 'streams' }, state: !words ? 'idle' : 'done', count: serverCount, loose: 0, error: null },
    {
      source: { id: 'catalog', name: 'The catalog (TMDB)', group: 'streams' },
      state: !words ? 'idle' : titles.isFetching ? 'searching' : titles.error ? 'failed' : 'done',
      count: catalog.length,
      loose: 0,
      error: titles.error ?? null,
    },
  ]
  const nothing = !searching && Object.values(counts).every((n) => n === 0)

  return (
    <div className="space-y-6">
      {/* the field is the page: no button beside it (Enter searches), the kind sits with the tabs */}
      <form onSubmit={submit} className="space-y-3">
        <h1 className="text-xl font-semibold tracking-tight">Search</h1>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-5 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={input}
            autoFocus={!q}
            value={text}
            maxLength={4096}
            onChange={(e) => setText(e.target.value)}
            placeholder="A movie, a show, or a link to read"
            aria-label="Search, or paste a link"
            className="h-14 border-transparent bg-card pr-36 pl-13 text-base md:text-lg dark:bg-card"
          />
          <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
            {text && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Clear"
                onClick={() => {
                  setText('')
                  input.current?.focus()
                }}
              >
                <X />
              </Button>
            )}
            <Button type="submit" size="sm" className="h-10 px-4" disabled={!text.trim()}>
              {isLink(text) ? 'Read link' : 'Search'}
            </Button>
          </div>
        </div>
        {q && !link && (
          <SourcesSummary states={states} fixed={fixed} off={off} onToggle={(id) => setOff((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]))} />
        )}
      </form>

      {!q ? (
        <Start
          kind={kind}
          noPlugins={noPlugins}
          sourceCount={states.length}
          recent={recent.filter((r) => r.kind === kind)}
          onPick={(r) => {
            setText(r.q)
            onSearch(r)
          }}
          onForget={() => {
            saveRecent(recent.filter((r) => r.kind !== kind))
            setRecent(loadRecent())
          }}
        />
      ) : link ? (
        <LinkView url={q} onAdd={(l, name) => setAdding({ link: l, name })} />
      ) : (
        <div className="space-y-6">
          {/* what to look at: the tabs, and what kind of title (it searches again) */}
          <div className="flex items-center gap-3 border-b">
            {railed ? (
              <div role="tablist" aria-label="Results" className="-mb-px flex min-w-0 flex-1 gap-6 overflow-x-auto [scrollbar-width:none]">
                {tabs.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    role="tab"
                    aria-selected={view === g.id}
                    onClick={() => onView(g.id)}
                    className={cn(
                      'flex h-11 shrink-0 items-center gap-1.5 border-b-2 text-sm transition-colors',
                      view === g.id ? 'border-gold font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {g.label}
                    {g.id !== 'all' && <span className="text-xs text-muted-foreground tabular-nums">{counts[g.id]}</span>}
                  </button>
                ))}
              </div>
            ) : (
              <div className="min-w-0 flex-1 pb-3">
                <Select value={view} onValueChange={(v) => onView(v as View)}>
                  <SelectTrigger aria-label="Results" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tabs.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.label} {g.id !== 'all' ? counts[g.id] : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className={cn('shrink-0', !railed && 'pb-3')}>
              <Select value={kind} onValueChange={(v) => onSearch({ q, kind: v as SearchKind })}>
                <SelectTrigger size="sm" aria-label="What to find" className="border-transparent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {KINDS.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {view === 'all' &&
            (nothing ? (
              <Empty icon={<SearchX />} title={`Nothing found for “${words}”`}>
                Try fewer words, or the title as it was released. {kind === 'tv' ? 'Shows are often listed as “Title S01E05”.' : 'Adding the year helps with common titles.'}
              </Empty>
            ) : (
              <div className="space-y-10">
                {serverCount > 0 && (
                  <section className="space-y-3">
                    <SectionHead title="On this server" count={serverCount} onAll={serverCount > 3 ? () => onView('server') : undefined} />
                    <ServerResults titles={server.titles} downloads={server.downloads} direct={server.direct} limit={3} />
                  </section>
                )}
                {catalog.length > 0 ? (
                  <section className="space-y-3">
                    <SectionHead title="Movies & shows" count={catalog.length} onAll={catalog.length > 8 ? () => onView('titles') : undefined} />
                    <TitlePosters titles={catalog} onOpen={setTitleOpen} limit={8} strip />
                  </section>
                ) : (
                  titles.isFetching && <Asking what="the catalog" />
                )}
                {(watchable.length > 0 || torrentList.length > 0) && (
                  <div className={cn('grid items-start gap-x-6 gap-y-10', watchable.length > 0 && torrentList.length > 0 && 'xl:grid-cols-2')}>
                    {watchable.length > 0 && (
                      <section className="min-w-0 space-y-3">
                        <SectionHead title="Watch now" count={watchable.length} onAll={watchable.length > 4 ? () => onView('streams') : undefined} />
                        <StreamRows items={watchable.slice(0, 4)} sourceName={nameOf} />
                      </section>
                    )}
                    {torrentList.length > 0 && (
                      <section className="min-w-0 space-y-3">
                        <SectionHead title="Download" count={counts.torrents} onAll={counts.torrents > 4 ? () => onView('torrents') : undefined} />
                        <TorrentRows releases={torrentList.slice(0, 4)} kept={kept} sourceName={(t) => nameOf(t.provider)} onAdd={addTorrent} />
                      </section>
                    )}
                  </div>
                )}
                {channels.length > 0 && (
                  <section className="space-y-3">
                    <SectionHead title="Live TV" count={channels.length} onAll={channels.length > 4 ? () => onView('live') : undefined} />
                    <LiveResults channels={channels} names={nameOf} limit={4} />
                  </section>
                )}
              </div>
            ))}

          {view === 'server' &&
            (serverCount ? (
              <ServerResults titles={server.titles} downloads={server.downloads} direct={server.direct} />
            ) : (
              <Empty icon={<SearchX />} title="Nothing on this server">
                No title in the library and no download has “{words}” in its name.
              </Empty>
            ))}

          {view === 'titles' &&
            (titles.isPending ? (
              <Asking what="the catalog" />
            ) : catalog.length ? (
              <TitlePosters titles={catalog} onOpen={setTitleOpen} />
            ) : (
              <Empty icon={<SearchX />} title={titles.error ? 'The catalog didn’t answer' : 'No movie or show by that name'}>
                {titles.error ? 'Try again in a moment.' : 'Try fewer words, or the original title.'}
              </Empty>
            ))}

          {view === 'streams' && (
            <Group
              searching={streams.searching}
              total={allStreams.length}
              list={streamList}
              loose={allStreams.filter((x) => x.matches === false && keep(x, streamFilters, 'loose')).length}
              filters={streamFilters}
              setFilters={setStreamFilters}
              hasMore={streams.hasMore}
              onMore={streams.loadMore}
              what="streams and files"
              bar={<FilterBar all={allStreams} filters={streamFilters} set={(f) => setStreamFilters((o) => ({ ...o, ...f }))} torrents={false} shows={kind !== 'movie'} />}
            >
              <StreamRows items={streamList} sourceName={nameOf} />
            </Group>
          )}

          {view === 'torrents' && (
            <Group
              searching={torrents.searching}
              total={allTorrents.length}
              list={torrentList}
              loose={allTorrents.filter((t) => t.matches === false && keep(t, torrentFilters, 'loose')).length}
              filters={torrentFilters}
              setFilters={setTorrentFilters}
              hasMore={torrents.hasMore}
              onMore={torrents.loadMore}
              what="torrents"
              bar={<FilterBar all={allTorrents} filters={torrentFilters} set={(f) => setTorrentFilters((o) => ({ ...o, ...f }))} torrents shows={kind !== 'movie'} />}
            >
              {railed ? (
                <TorrentTable releases={torrentList} kept={kept} sourceName={(t) => nameOf(t.provider)} onAdd={addTorrent} />
              ) : (
                <TorrentRows releases={torrentList} kept={kept} sourceName={(t) => nameOf(t.provider)} onAdd={addTorrent} />
              )}
            </Group>
          )}

          {view === 'live' &&
            (live.searching && !channels.length ? (
              <Asking what="the live plugins" />
            ) : channels.length ? (
              <LiveResults channels={channels} names={nameOf} />
            ) : (
              <Empty icon={<SearchX />} title="No channel by that name">
                A channel’s name, number or group must start with each word.
              </Empty>
            ))}
        </div>
      )}

      <TitleSourcesSheet title={titleOpen} onClose={() => setTitleOpen(null)} onAdd={(magnet, name) => setAdding({ link: magnet, name })} />
      {adding && (
        <AddDownloadDialog
          key={adding.link}
          open
          link={adding.link}
          labels={labels}
          onOpenChange={(o) => {
            if (!o) setAdding(null)
          }}
        />
      )}
    </div>
  )
}

// ── parts ───────────────────────────────────────────────────────────────────

function stateOf(
  source: SourceState['source'],
  s: { searching: boolean; error: unknown; items: object[] } | undefined,
  asked: boolean,
): SourceState {
  // channels have no `matches`: each one counts
  const items = (s?.items ?? []) as { matches?: boolean }[]
  return {
    source,
    state: !asked ? 'idle' : s?.searching ? 'searching' : s?.error ? 'failed' : 'done',
    count: items.filter((i) => i.matches !== false).length,
    loose: items.filter((i) => i.matches === false).length,
    error: s?.error ?? null,
  }
}

function Asking({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Spinner /> Asking {what}…
    </p>
  )
}

/** A narrowable group (streams, torrents): its count, the loose ones, filters, more pages */
function Group({
  children,
  searching,
  total,
  list,
  loose,
  filters,
  setFilters,
  hasMore,
  onMore,
  what,
  bar,
}: {
  children: ReactNode
  searching: boolean
  total: number
  list: unknown[]
  loose: number
  filters: Filters
  setFilters: (f: Filters) => void
  hasMore: boolean
  onMore: () => void
  what: string
  bar: ReactNode
}) {
  const filtered = JSON.stringify({ ...filters, loose: false }) !== JSON.stringify(NO_FILTERS)
  if (searching && !total) return <Asking what={`the sources for ${what}`} />
  if (!total) {
    return (
      <Empty icon={<SearchX />} title={`No ${what} found`}>
        Try fewer words, or another spelling of the title.
      </Empty>
    )
  }
  const link = 'text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground'
  return (
    <div className="space-y-4">
      {bar}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {list.length} {what}
        </span>
        {loose > 0 && (
          <button type="button" className={link} onClick={() => setFilters({ ...filters, loose: !filters.loose })}>
            {filters.loose ? 'Hide' : 'Show'} {loose} near {loose === 1 ? 'match' : 'matches'}
          </button>
        )}
        {filtered && (
          <button type="button" className={link} onClick={() => setFilters({ ...NO_FILTERS, loose: filters.loose })}>
            Clear filters
          </button>
        )}
        {searching && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Spinner /> Still asking
          </span>
        )}
      </div>
      {list.length === 0 ? (
        <Empty icon={<SearchX />} title="Nothing fits these filters">
          <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => setFilters(NO_FILTERS)}>
            Clear the filters
          </button>
        </Empty>
      ) : (
        children
      )}
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={searching} onClick={onMore}>
            {searching && <Spinner />} More results
          </Button>
        </div>
      )}
    </div>
  )
}

/** Before a search: what is asked, recent searches */
function Start({
  kind,
  noPlugins,
  sourceCount,
  recent,
  onPick,
  onForget,
}: {
  kind: SearchKind
  noPlugins: boolean
  sourceCount: number
  recent: Recent[]
  onPick: (r: Recent) => void
  onForget: () => void
}) {
  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        Searches this server, the catalog{sourceCount ? ` and ${sourceCount} ${sourceCount === 1 ? 'plugin source' : 'plugin sources'}` : ''} at once
        {kind === 'all' ? '' : kind === 'movie' ? ', for movies' : ', for shows'}. Or paste a link (a page, a video, a magnet, a .torrent) to see what it holds.
      </p>
      {noPlugins && (
        <div className="flex items-start gap-3 rounded-xl bg-card p-4 text-sm">
          <Puzzle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-2">
            <p>No source plugins are installed: Search only finds what is on this server and in the catalog. Torrent sites and streaming services come as plugins.</p>
            <Button asChild size="sm" variant="outline">
              <Link to="/plugins?tab=browse">Browse plugins</Link>
            </Button>
          </div>
        </div>
      )}
      {recent.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-base font-medium">Recent searches</h2>
            <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={onForget}>
              Forget them
            </button>
          </div>
          <ul className="divide-y overflow-hidden rounded-xl bg-card">
            {recent.map((r) => (
              <li key={r.q}>
                <button type="button" onClick={() => onPick(r)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-accent">
                  <Search className="size-4 text-muted-foreground" />
                  <span className="truncate">{r.q}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
