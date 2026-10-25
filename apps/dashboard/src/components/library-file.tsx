import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EyeOff, Film, FolderOpen, Play, Search, Tv, Undo2 } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Loading, Mono, QueryError, Spinner } from '@/components/common'
import { fileName, itemLabel, pad, Poster, type LibraryFile, type LibraryFolder, type LibraryItem, type Parsed } from '@/components/library-common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { bytes, clock, dateTime } from '@/lib/format'
import { placeOf, usePlayer } from '@/lib/player'

// One library file in a sheet (the Library's ?file=): what it is, fixing its
// match (TMDB search; the admin's match survives rescans), ignoring it, its
// streams and subtitle files, playing it, its folder.

export function FileSheet({ id, folders, onClose }: { id: string | null; folders: LibraryFolder[]; onClose: () => void }) {
  const client = useQueryClient()
  const player = usePlayer()
  const navigate = useNavigate()
  const [fixing, setFixing] = useState(false)
  const detail = useQuery({
    queryKey: ['library-file', id],
    queryFn: () => unwrap(api.GET('/admin/library/files/{id}', { params: { path: { id: id! } } })),
    enabled: !!id,
  })
  const file = detail.data
  const folder = folders.find((f) => f.id === file?.folderId)
  const changed = (message: string) => (updated: LibraryFile) => {
    toast.success(message)
    client.setQueryData(['library-file', updated.id], updated)
    client.invalidateQueries({ queryKey: ['library-files'] })
    client.invalidateQueries({ queryKey: ['library'] })
  }
  const fail = (err: unknown) => toast.error(errorMessage(err))
  const unmatch = useMutation({
    mutationFn: () => unwrap(api.DELETE('/admin/library/files/{id}/match', { params: { path: { id: id! } } })),
    onSuccess: changed('Match forgotten: the next scan matches it again'),
    onError: fail,
  })
  const ignore = useMutation({
    mutationFn: (ignored: boolean) => unwrap(api.PUT('/admin/library/files/{id}/ignored', { params: { path: { id: id! } }, body: { ignored } })),
    onSuccess: (updated, ignored) => changed(ignored ? 'Ignored: devices no longer see it' : 'No longer ignored')(updated),
    onError: fail,
  })

  return (
    <Sheet
      open={!!id}
      onOpenChange={(o) => {
        if (!o) {
          setFixing(false)
          onClose()
        }
      }}
    >
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="pr-6 break-all">{file ? fileName(file.relPath) : 'File'}</SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">{file && folder ? `${folder.path}/${file.relPath}` : null}</SheetDescription>
        </SheetHeader>
        {detail.isPending && id ? (
          <div className="px-4">
            <Loading />
          </div>
        ) : detail.error ? (
          <div className="px-4">
            <QueryError error={detail.error} title="Could not load this file" />
          </div>
        ) : file ? (
          <div className="space-y-6 px-4 pb-6">
            <div className="flex flex-wrap gap-2">
              {file.state !== 'missing' && (
                <Button
                  onClick={() =>
                    player.play({ ref: file.ref, title: file.item ? itemLabel(file.item) : fileName(file.relPath), detail: folder?.path, ...placeOf(file.folderId, file.relPath) })
                  }
                >
                  <Play /> Play
                </Button>
              )}
              {file.state !== 'missing' && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const at = placeOf(file.folderId, file.relPath)
                    navigate(`/library?place=${encodeURIComponent(at.place)}${at.dir ? `&path=${encodeURIComponent(at.dir)}` : ''}`)
                  }}
                >
                  <FolderOpen /> Show in its folder
                </Button>
              )}
            </div>
            <Section title="Match">
              {file.item ? <ItemCard item={file.item} matchedBy={file.matchedBy} /> : <p className="text-sm text-warning">Not matched to a movie or an episode.</p>}
              {file.state === 'missing' && (
                <p className="text-sm text-destructive">Missing from the disk since {dateTime(file.missingSince)}; forgotten after 7 days.</p>
              )}
              <div className="flex flex-wrap gap-2">
                {file.state !== 'ignored' && (
                  <Button size="sm" variant={file.item ? 'outline' : 'default'} onClick={() => setFixing(!fixing)}>
                    <Search /> {file.item ? 'Fix match…' : 'Match…'}
                  </Button>
                )}
                {file.item && (
                  <Button size="sm" variant="outline" disabled={unmatch.isPending} onClick={() => unmatch.mutate()} title="The next scan matches it on its own">
                    <Undo2 /> Forget match
                  </Button>
                )}
                {file.state === 'ignored' ? (
                  <Button size="sm" variant="outline" disabled={ignore.isPending} onClick={() => ignore.mutate(false)}>
                    <Undo2 /> Stop ignoring
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={ignore.isPending} onClick={() => ignore.mutate(true)} title="Hidden from devices, never matched">
                    <EyeOff /> Ignore
                  </Button>
                )}
              </div>
              {fixing && file.state !== 'ignored' && (
                <MatchPicker
                  file={file}
                  folder={folder}
                  onDone={(updated) => {
                    setFixing(false)
                    changed(`Matched: ${updated.item ? itemLabel(updated.item) : ''}`)(updated)
                  }}
                />
              )}
            </Section>
            <FileFacts file={file} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  )
}



const MATCHED_BY: Record<string, string> = { auto: 'matched from its name', nfo: 'matched from its .nfo file', admin: 'matched by hand (kept by rescans)' }

function ItemCard({ item, matchedBy }: { item: LibraryItem; matchedBy: string | null }) {
  const art = item.artwork
  return (
    <div className="flex gap-3 rounded-md border p-3">
      <Poster path={art?.posterPath} />
      <div className="min-w-0 space-y-0.5 text-sm">
        <div className="font-medium">
          {item.title ?? '—'}
          {item.year && <span className="text-muted-foreground"> ({item.year})</span>}
        </div>
        {item.kind === 'episode' && (
          <div>
            S{pad(item.season)}E{pad(item.episode)}
            {item.episodeTitle && ` · ${item.episodeTitle}`}
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          {item.kind === 'episode' ? 'Episode' : 'Movie'} · {matchedBy ? MATCHED_BY[matchedBy] ?? matchedBy : 'matched'}
        </div>
        <div className="flex flex-wrap gap-x-3 font-mono text-xs">
          {(item.kind === 'movie' ? item.tmdbId : item.showTmdbId) && (
            <a
              className="text-primary underline-offset-4 hover:underline"
              href={`https://www.themoviedb.org/${item.kind === 'movie' ? `movie/${item.tmdbId}` : `tv/${item.showTmdbId}/season/${item.season}/episode/${item.episode}`}`}
              target="_blank"
              rel="noreferrer"
            >
              TMDB
            </a>
          )}
          {item.imdbId && (
            <a className="text-primary underline-offset-4 hover:underline" href={`https://www.imdb.com/title/${item.imdbId}/`} target="_blank" rel="noreferrer">
              IMDb {item.imdbId}
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// Search TMDB, pick a movie, or a show then its season and episode
function MatchPicker({ file, folder, onDone }: { file: LibraryFile; folder: LibraryFolder | undefined; onDone: (file: LibraryFile) => void }) {
  const parsed = (file.parse ?? {}) as Parsed
  const initialKind =
    file.item?.kind === 'episode' || (!file.item && (folder?.kind === 'shows' || (folder?.kind !== 'movies' && parsed.kind === 'episode')))
      ? 'tv'
      : 'movie'
  const [kind, setKind] = useState<'movie' | 'tv'>(initialKind)
  const [q, setQ] = useState(file.item?.title ?? parsed.title ?? '')
  const [year, setYear] = useState(kind === 'movie' ? String(file.item?.year ?? parsed.year ?? '') : '')
  const [asked, setAsked] = useState<{ kind: 'movie' | 'tv'; q: string; year: number | null } | null>(null)
  const [show, setShow] = useState<{ tmdbId: number; title: string } | null>(null)
  const [season, setSeason] = useState(String(file.item?.season ?? parsed.season ?? 1))
  const [episode, setEpisode] = useState(String(file.item?.episode ?? parsed.episode ?? 1))

  const results = useQuery({
    queryKey: ['library-search', asked],
    queryFn: () =>
      unwrap(api.GET('/admin/library/search', { params: { query: { kind: asked!.kind, q: asked!.q, ...(asked!.year && { year: asked!.year }) } } })),
    enabled: !!asked,
  })
  const match = useMutation({
    mutationFn: (body: Schemas['LibraryMatch']) => unwrap(api.PUT('/admin/library/files/{id}/match', { params: { path: { id: file.id } }, body })),
    onSuccess: onDone,
    onError: (err) => toast.error(errorMessage(err)),
  })
  const search = (e: FormEvent) => {
    e.preventDefault()
    if (!q.trim()) return
    setShow(null)
    setAsked({ kind, q: q.trim(), year: parseInt(year, 10) || null })
  }
  const pickEpisode = (e: FormEvent) => {
    e.preventDefault()
    const s = parseInt(season, 10)
    const ep = parseInt(episode, 10)
    if (show && s >= 0 && ep >= 1) match.mutate({ kind: 'episode', showTmdbId: show.tmdbId, season: s, episode: ep })
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <form onSubmit={search} className="space-y-2">
        <Tabs value={kind} onValueChange={(v) => setKind(v as 'movie' | 'tv')}>
          <TabsList>
            <TabsTrigger value="movie">
              <Film /> Movie
            </TabsTrigger>
            <TabsTrigger value="tv">
              <Tv /> Episode
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex gap-2">
          <Input value={q} placeholder={kind === 'movie' ? 'Movie title' : 'Show title'} aria-label="Title" onChange={(e) => setQ(e.target.value)} />
          <Input value={year} placeholder="Year" inputMode="numeric" aria-label="Year" className="w-20" onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} />
          <Button type="submit" disabled={!q.trim()}>
            <Search /> Search
          </Button>
        </div>
      </form>
      {results.isFetching && <Spinner className="text-muted-foreground" />}
      {results.error && <p className="text-sm text-destructive">{errorMessage(results.error)}</p>}
      {show ? (
        <form onSubmit={pickEpisode} className="space-y-2">
          <p className="text-sm">
            <span className="font-medium">{show.title}</span>{' '}
            <button type="button" className="text-xs text-primary underline-offset-4 hover:underline" onClick={() => setShow(null)}>
              change
            </button>
          </p>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="match-season">Season</Label>
              <Input id="match-season" value={season} inputMode="numeric" className="w-20" onChange={(e) => setSeason(e.target.value.replace(/\D/g, ''))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="match-episode">Episode</Label>
              <Input id="match-episode" value={episode} inputMode="numeric" className="w-20" onChange={(e) => setEpisode(e.target.value.replace(/\D/g, ''))} />
            </div>
            <Button type="submit" disabled={match.isPending || !season || !episode}>
              {match.isPending && <Spinner />} Match
            </Button>
          </div>
        </form>
      ) : (
        results.data &&
        (results.data.results.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing found on TMDB{asked?.year ? `; try without the year` : ''}.</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto rounded-md border bg-background">
            {results.data.results.map((r) => (
              <li key={r.tmdbId}>
                <button
                  type="button"
                  disabled={match.isPending}
                  className="flex w-full gap-3 p-2 text-left hover:bg-muted disabled:opacity-60"
                  onClick={() => (asked?.kind === 'tv' ? setShow({ tmdbId: r.tmdbId, title: r.title }) : match.mutate({ kind: 'movie', tmdbId: r.tmdbId }))}
                >
                  <Poster path={r.posterPath} className="w-10" />
                  <div className="min-w-0 text-sm">
                    <div className="font-medium">
                      {r.title}
                      {r.year && <span className="text-muted-foreground"> ({r.year})</span>}
                    </div>
                    {r.overview && <p className="line-clamp-2 text-xs text-muted-foreground">{r.overview}</p>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ))
      )}
    </div>
  )
}

function FileFacts({ file }: { file: LibraryFile }) {
  const parsed = (file.parse ?? {}) as Parsed
  const p = file.probe
  const said = [
    parsed.title,
    parsed.year,
    parsed.season !== null && parsed.season !== undefined && `S${pad(parsed.season)}E${pad(parsed.episode)}${parsed.episodeEnd ? `–E${pad(parsed.episodeEnd)}` : ''}`,
    parsed.resolution,
    parsed.source,
    parsed.codec,
  ].filter(Boolean)
  return (
    <>
      <Section title="File">
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Size</dt>
          <dd className="tabular-nums">{bytes(file.size)}</dd>
          <dt className="text-muted-foreground">Modified</dt>
          <dd>{dateTime(file.mtime)}</dd>
          <dt className="text-muted-foreground">Added</dt>
          <dd>{dateTime(file.addedAt)}</dd>
          <dt className="text-muted-foreground">Its name says</dt>
          <dd>{said.length ? said.join(' · ') : '—'}</dd>
          <dt className="text-muted-foreground">Media ref</dt>
          <dd className="font-mono text-xs break-all">{file.ref}</dd>
        </dl>
      </Section>
      <Section title="Streams">
        {!p ? (
          <p className="text-sm text-muted-foreground">Not probed (ffprobe missing, or the file couldn't be read).</p>
        ) : (
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Duration</dt>
            <dd className="tabular-nums">{clock(p.duration)}</dd>
            <dt className="text-muted-foreground">Video</dt>
            <dd>{[p.video, p.width && p.height && `${p.width}×${p.height}`, p.hdr && 'HDR'].filter(Boolean).join(' · ') || '—'}</dd>
            <dt className="text-muted-foreground">Audio</dt>
            <dd>
              {p.audio.length
                ? p.audio.map((a, i) => (
                    <div key={i}>
                      {[a.codec, a.channels && `${a.channels} ch`, a.language, a.title, a.default && 'default'].filter(Boolean).join(' · ')}
                    </div>
                  ))
                : '—'}
              {p.transcode && <div className="text-xs text-warning">Its audio is converted to AAC for Playpex TV</div>}
            </dd>
            <dt className="text-muted-foreground">Subtitles inside</dt>
            <dd>{p.subtitles?.length ? p.subtitles.map((s) => [s.language ?? '?', s.forced && 'forced', s.codec].filter(Boolean).join(' ')).join(', ') : 'none'}</dd>
          </dl>
        )}
      </Section>
      <Section title="Subtitle files">
        {file.subtitles.length ? (
          <ul className="space-y-1 text-sm">
            {file.subtitles.map((s) => (
              <li key={s.index} className="flex min-w-0 items-center gap-2">
                <Badge variant="outline">{s.language ?? '?'}</Badge>
                {s.forced && <Badge variant="secondary">forced</Badge>}
                {s.sdh && <Badge variant="secondary">SDH</Badge>}
                <Mono className="text-muted-foreground">{s.relPath}</Mono>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None next to it.</p>
        )}
      </Section>
    </>
  )
}
