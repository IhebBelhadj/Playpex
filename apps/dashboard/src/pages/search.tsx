import { Puzzle, Search, SearchX, X } from 'lucide-react'
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AddDownloadDialog } from '@/components/add-download'
import { Empty, Spinner } from '@/components/common'
import { useLibraryHome } from '@/components/library-titles'
import { RailGroup, RailItem, useIsDesktop } from '@/components/rail'
import { LinkView } from '@/components/search/link'
import { StreamRows, TorrentRows } from '@/components/search/offers'
import { Facets, keep, NO_FILTERS, PhoneFacets, sameSource, SectionHead, SourceDot, SourcesLine, type Filters } from '@/components/search/parts'
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
  const desktop = useIsDesktop()

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
  const allStreams = shown(streams.items)
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

  // a plugin that is both (OpenScrapers): "<name> files", "<name> torrents"
  const both = new Set(sources.streams.filter((s) => sources.torrents.some((t) => t.id === s.id)).map((s) => s.id))
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

  const groups: { id: View; label: string; shown: boolean }[] = [
    { id: 'all', label: 'All results', shown: true },
    { id: 'server', label: 'On this server', shown: true },
    { id: 'titles', label: 'Movies & shows', shown: true },
    { id: 'streams', label: 'Streams & files', shown: sources.streams.length > 0 },
    { id: 'torrents', label: 'Torrents', shown: sources.torrents.length > 0 },
    { id: 'live', label: 'Live TV', shown: sources.live.length > 0 },
  ]

  return (
    <div className="flex flex-col gap-5 md:h-[calc(100svh-4rem)]">
      {/* the field: the page's first thing */}
      <form onSubmit={submit} className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">Search</h1>
          <div role="radiogroup" aria-label="What to find" className="inline-flex rounded-lg border bg-card p-0.5 sm:ml-auto">
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={kind === k.id}
                onClick={() => onSearch({ q, kind: k.id })}
                className={cn('rounded-md px-3 py-1 text-sm transition-colors', kind === k.id ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={input}
              autoFocus={!q}
              value={text}
              maxLength={4096}
              onChange={(e) => setText(e.target.value)}
              placeholder="A title, or paste a link: a page, a video, a magnet"
              aria-label="Search, or paste a link"
              className="h-12 rounded-xl pr-10 pl-11 text-base md:text-lg"
            />
            {text && (
              <button
                type="button"
                aria-label="Clear"
                onClick={() => {
                  setText('')
                  input.current?.focus()
                }}
                className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <Button type="submit" className="h-12 rounded-xl px-5" disabled={!text.trim()}>
            {isLink(text) ? 'Read link' : 'Search'}
          </Button>
        </div>
        {!link && (
          <SourcesLine
            states={states}
            off={off}
            onToggle={(id) => setOff((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]))}
            extra={
              <>
                <Fixed label="This server" state={!words ? 'idle' : 'done'} count={serverCount} />
                <Fixed label="Catalog" state={!words ? 'idle' : titles.isFetching ? 'searching' : titles.error ? 'failed' : 'done'} count={catalog.length} />
              </>
            }
          />
        )}
      </form>

      {!q ? (
        <Start
          kind={kind}
          sources={[...sources.streams.map((s) => s.name), ...sources.torrents.map((s) => s.name), ...sources.live.map((l) => l.name)]}
          noPlugins={noPlugins}
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
        <div className="min-h-0 flex-1 overflow-y-auto">
          <LinkView url={q} onAdd={(l, name) => setAdding({ link: l, name })} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-6">
          {desktop && (
            <nav aria-label="Results" className="flex w-48 shrink-0 flex-col gap-5 overflow-y-auto pb-4 [scrollbar-width:thin]">
              <RailGroup>
                {groups
                  .filter((g) => g.shown)
                  .map((g) => (
                    <RailItem key={g.id} label={g.label} count={g.id === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[g.id]} active={view === g.id} onClick={() => onView(g.id)} />
                  ))}
              </RailGroup>
              {view === 'torrents' && allTorrents.length > 0 && (
                <Facets all={allTorrents} filters={torrentFilters} set={(p) => setTorrentFilters((f) => ({ ...f, ...p }))} torrents shows={kind !== 'movie'} />
              )}
              {view === 'streams' && allStreams.length > 0 && (
                <Facets all={allStreams} filters={streamFilters} set={(p) => setStreamFilters((f) => ({ ...f, ...p }))} torrents={false} shows={kind !== 'movie'} />
              )}
            </nav>
          )}

          <section aria-label="Results" className="flex min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto pb-6">
            {!desktop && (
              <div className="space-y-2">
                <Select value={view} onValueChange={(v) => onView(v as View)}>
                  <SelectTrigger aria-label="Results" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {groups
                      .filter((g) => g.shown)
                      .map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.label} {g.id !== 'all' ? counts[g.id] : ''}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {view === 'torrents' && <PhoneFacets filters={torrentFilters} set={(p) => setTorrentFilters((f) => ({ ...f, ...p }))} torrents shows={kind !== 'movie'} />}
                {view === 'streams' && <PhoneFacets filters={streamFilters} set={(p) => setStreamFilters((f) => ({ ...f, ...p }))} torrents={false} shows={kind !== 'movie'} />}
              </div>
            )}

            {view === 'all' && (
              <Overview
                searching={searching}
                empty={!searching && Object.values(counts).every((n) => n === 0)}
                q={words}
                kind={kind}
                sections={[
                  serverCount > 0 && (
                    <section key="server" className="space-y-3">
                      <SectionHead title="On this server" count={serverCount} onAll={serverCount > 6 ? () => onView('server') : undefined} />
                      <ServerResults titles={server.titles} downloads={server.downloads} direct={server.direct} limit={6} />
                    </section>
                  ),
                  catalog.length > 0 && (
                    <section key="titles" className="space-y-3">
                      <SectionHead title="Movies & shows" count={catalog.length} onAll={catalog.length > 12 ? () => onView('titles') : undefined} />
                      <TitlePosters titles={catalog} onOpen={setTitleOpen} limit={12} strip />
                    </section>
                  ),
                  streamList.length > 0 && (
                    <section key="streams" className="space-y-3">
                      <SectionHead title="Streams & files" count={counts.streams} onAll={() => onView('streams')} />
                      <StreamRows items={streamList.filter((s) => s.matches !== false).slice(0, 5)} sourceName={nameOf} />
                    </section>
                  ),
                  torrentList.length > 0 && (
                    <section key="torrents" className="space-y-3">
                      <SectionHead title="Torrents" count={counts.torrents} onAll={() => onView('torrents')} />
                      <TorrentRows releases={torrentList.slice(0, 6)} kept={kept} sourceName={(t) => nameOf(t.provider)} onAdd={addTorrent} />
                    </section>
                  ),
                  channels.length > 0 && (
                    <section key="live" className="space-y-3">
                      <SectionHead title="Live TV" count={channels.length} onAll={channels.length > 6 ? () => onView('live') : undefined} />
                      <LiveResults channels={channels} names={nameOf} limit={6} />
                    </section>
                  ),
                ]}
              />
            )}

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
                loose={allStreams.filter((s) => s.matches === false && keep(s, streamFilters, 'loose')).length}
                filters={streamFilters}
                setFilters={setStreamFilters}
                hasMore={streams.hasMore}
                onMore={streams.loadMore}
                what="streams and files"
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
              >
                {desktop ? (
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
          </section>
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

/** A source that can't be left out (this server, the catalog): its state and count */
function Fixed({ label, state, count }: { label: string; state: SourceState['state']; count: number }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1">
      <SourceDot state={state} found={count > 0} />
      <span className="text-foreground">{label}</span>
      {state === 'searching' ? (
        <span className="text-xs text-muted-foreground">searching</span>
      ) : state === 'done' ? (
        <span className="text-xs text-muted-foreground tabular-nums">{count || 'nothing'}</span>
      ) : state === 'failed' ? (
        <span className="text-xs text-destructive">failed</span>
      ) : null}
    </span>
  )
}

function Asking({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Spinner /> Asking {what}…
    </p>
  )
}

/** The overview: each group's best, as they arrive */
function Overview({ sections, searching, empty, q, kind }: { sections: (ReactNode | false)[]; searching: boolean; empty: boolean; q: string; kind: SearchKind }) {
  const shown = sections.filter(Boolean)
  if (empty) {
    return (
      <Empty icon={<SearchX />} title={`Nothing found for “${q}”`}>
        Try fewer words, or the title as it was released. {kind === 'tv' ? 'Shows are often listed as “Title S01E05”.' : 'Adding the year helps with common titles.'}
      </Empty>
    )
  }
  return (
    <div className="space-y-8">
      {searching && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Still asking some sources: results join as they answer
        </p>
      )}
      {shown}
    </div>
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
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="font-medium tabular-nums">
          {list.length} {what}
        </span>
        {!filters.loose && loose > 0 && (
          <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setFilters({ ...filters, loose: true })}>
            {loose} more don’t have every word in their name
          </button>
        )}
        {filtered && (
          <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setFilters({ ...NO_FILTERS, loose: filters.loose })}>
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
    </>
  )
}

/** Before a search: what is asked, recent searches */
function Start({
  kind,
  sources,
  noPlugins,
  recent,
  onPick,
  onForget,
}: {
  kind: SearchKind
  sources: string[]
  noPlugins: boolean
  recent: Recent[]
  onPick: (r: Recent) => void
  onForget: () => void
}) {
  const asked = ['this server', 'the catalog', ...sources]
  const list = `${asked.slice(0, -1).join(', ')} and ${asked.at(-1)}`
  return (
    <div className="max-w-2xl space-y-6 pt-2">
      <p className="text-sm text-muted-foreground">
        Searches {list} at once{kind === 'all' ? '' : kind === 'movie' ? ', for movies' : ', for shows'}. Spelling is forgiving: “breaking bad”, “Breaking.Bad” and
        “breakingbad” find the same releases. Paste a link instead, a web page, a video, a stream, a magnet or a .torrent, to see what it holds.
      </p>
      {noPlugins && (
        <div className="flex items-start gap-3 rounded-lg border bg-card p-3 text-sm">
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
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium">Recent searches</h2>
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={onForget}>
              Forget them
            </button>
          </div>
          <ul className="flex flex-wrap gap-2">
            {recent.map((r) => (
              <li key={r.q}>
                <Button variant="outline" size="sm" onClick={() => onPick(r)}>
                  <Search /> {r.q}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
