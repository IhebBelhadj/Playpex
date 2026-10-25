import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowUp, Check, ChevronRight, FileText, Folder, Globe, HardDrive, Laptop, Minus, Plus, Search, Subtitles, X } from 'lucide-react'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Spinner } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { API_PREFIX, api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { cn } from '@/lib/utils'

// The player's subtitles (pages/watch.tsx): what shows and how (timing, size),
// the file's own tracks and the ones added here: found online by the server's
// subtitle providers, a file from this computer (converted by the server), or a
// subtitle file anywhere in the server's storage. Added tracks are WebVTT held
// by this page (blob URLs); nothing is saved with the file.

export type SubtitleChoice = {
  id: string
  label: string
  /** a second line: where it came from, its file */
  detail?: string
  url: string
  language?: string | null
  origin: 'file' | 'online' | 'computer' | 'server'
}

export const SIZES = [
  { id: 's', label: 'S', css: '1.1rem' },
  { id: 'm', label: 'M', css: '1.5rem' },
  { id: 'l', label: 'L', css: '2rem' },
  { id: 'xl', label: 'XL', css: '2.6rem' },
] as const

export type SizeId = (typeof SIZES)[number]['id']

type Title = NonNullable<Schemas['MediaPlayback']['title']>

/** WebVTT text → a URL the <track> element reads */
function vttUrl(text: string) {
  return URL.createObjectURL(new Blob([text], { type: 'text/vtt' }))
}

async function fetchVtt(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, { credentials: 'same-origin', ...init })
  const text = await res.text()
  if (!res.ok) {
    let message = `The server answered ${res.status}`
    try {
      message = JSON.parse(text).error ?? message
    } catch {
      // not JSON: the status says it
    }
    throw new Error(message)
  }
  if (!/^﻿?WEBVTT/.test(text)) throw new Error('That isn’t a subtitle the browser can show')
  return text
}

/** "Movie.en.forced.srt" → en */
function languageOf(name: string): string | null {
  return /\.([a-z]{2,3})(?:\.(?:forced|sdh|cc|hi))?\.[a-z]{3}$/i.exec(name)?.[1]?.toLowerCase() ?? null
}

const SUBTITLE_FILE = /\.(srt|ass|ssa|vtt)$/i

function defaultLanguages() {
  const own = (navigator.language || 'en').slice(0, 2).toLowerCase()
  return own === 'en' ? 'en' : `${own},en`
}

export function SubtitlePanel({
  title,
  fileId,
  choices,
  selected,
  onSelect,
  onAdd,
  delay,
  onDelay,
  size,
  onSize,
  place,
  dir,
  onClose,
  className,
}: {
  title: Title | null
  fileId: string | null
  choices: SubtitleChoice[]
  selected: string
  onSelect: (id: string) => void
  onAdd: (choice: SubtitleChoice) => void
  delay: number
  onDelay: (seconds: number) => void
  size: SizeId
  onSize: (size: SizeId) => void
  place?: string
  dir?: string
  onClose: () => void
  className?: string
}) {
  const [picking, setPicking] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)

  const add = (text: string, choice: Omit<SubtitleChoice, 'url' | 'id'>) => {
    const made = { ...choice, id: `x:${crypto.randomUUID()}`, url: vttUrl(text) }
    onAdd(made)
    toast.success(`Showing ${choice.label}`)
  }

  const fromComputer = async (file: File) => {
    setReading(true)
    try {
      const lang = languageOf(file.name)
      const text = await fetchVtt(`${API_PREFIX}/subtitles/convert${lang ? `?lang=${lang}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      })
      add(text, { label: file.name, detail: 'From this computer', language: lang, origin: 'computer' })
    } catch (err) {
      toast.error(`Couldn’t read ${file.name}`, { description: errorMessage(err) })
    } finally {
      setReading(false)
    }
  }

  const own = choices.filter((c) => c.origin === 'file')
  const added = choices.filter((c) => c.origin !== 'file')

  return (
    <aside aria-label="Subtitles" className={cn('flex h-full w-full flex-col bg-background text-foreground', className)}>
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Subtitles className="size-4 text-muted-foreground" />
        <h2 className="mr-auto text-sm font-semibold">Subtitles</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close subtitles" onClick={onClose}>
          <X />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <Section title="Showing">
          <ul className="space-y-0.5">
            <ChoiceRow active={selected === 'off'} label="Off" onClick={() => onSelect('off')} />
            {own.map((c) => (
              <ChoiceRow key={c.id} active={selected === c.id} label={c.label} detail={c.detail} onClick={() => onSelect(c.id)} />
            ))}
            {added.map((c) => (
              <ChoiceRow key={c.id} active={selected === c.id} label={c.label} detail={c.detail} onClick={() => onSelect(c.id)} />
            ))}
          </ul>
          {own.length === 0 && added.length === 0 && (
            <p className="text-xs text-muted-foreground">This file has no subtitles the browser can show. Find some below.</p>
          )}
        </Section>

        <div className={cn('grid grid-cols-2 gap-4', selected === 'off' && 'opacity-50')}>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground" id="sub-delay">
              Timing
            </p>
            <div className="flex items-center gap-1" role="group" aria-labelledby="sub-delay">
              <Button variant="outline" size="icon-sm" aria-label="Show subtitles earlier (G)" title="Earlier (G)" onClick={() => onDelay(delay - 0.25)}>
                <Minus />
              </Button>
              <button
                type="button"
                className="min-w-14 rounded px-1 text-center text-sm tabular-nums hover:bg-muted"
                title="Back to the file’s timing"
                onClick={() => onDelay(0)}
              >
                {delay === 0 ? '0 s' : `${delay > 0 ? '+' : '−'}${Math.abs(delay)} s`}
              </button>
              <Button variant="outline" size="icon-sm" aria-label="Show subtitles later (H)" title="Later (H)" onClick={() => onDelay(delay + 0.25)}>
                <Plus />
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground" id="sub-size">
              Size
            </p>
            <div className="flex rounded-md border p-0.5" role="radiogroup" aria-labelledby="sub-size">
              {SIZES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={size === s.id}
                  className={cn('flex-1 rounded-[5px] py-0.5 text-xs', size === s.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                  onClick={() => onSize(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <FindOnline title={title} fileId={fileId} onAdd={add} />

        <Section title="Add a file">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={reading} onClick={() => fileInput.current?.click()}>
              {reading ? <Spinner /> : <Laptop />} This computer
            </Button>
            <Button variant="outline" onClick={() => setPicking(true)}>
              <HardDrive /> The server
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">SRT, ASS, SSA or WebVTT. Added subtitles stay while this page is open.</p>
          <input
            ref={fileInput}
            type="file"
            accept=".srt,.vtt,.ass,.ssa,text/vtt"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) fromComputer(file)
            }}
          />
        </Section>
      </div>

      <ServerPicker
        open={picking}
        onOpenChange={setPicking}
        place={place}
        dir={dir}
        onPick={(text, name) => {
          setPicking(false)
          add(text, { label: name, detail: 'From the server', language: languageOf(name), origin: 'server' })
        }}
      />
    </aside>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function ChoiceRow({ active, label, detail, onClick }: { active: boolean; label: string; detail?: string; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={active}
        onClick={onClick}
        className={cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted', active && 'bg-muted')}
      >
        <Check className={cn('mt-0.5 size-4 shrink-0 text-primary', !active && 'invisible')} />
        <span className="min-w-0">
          <span className="block truncate">{label}</span>
          {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
        </span>
      </button>
    </li>
  )
}

// The server's subtitle providers, for the title the server knows this file is
function FindOnline({ title, fileId, onAdd }: { title: Title | null; fileId: string | null; onAdd: (text: string, choice: Omit<SubtitleChoice, 'url' | 'id'>) => void }) {
  const episode = title?.mediaType === 'tv' && title.season !== null && title.episode !== null
  const providers = useQuery({ queryKey: ['subtitle-providers'], queryFn: () => unwrap(api.GET('/subtitles/providers')), staleTime: 5 * 60_000 })
  const usable = (providers.data ?? []).filter((p) => p.enabled && (episode ? p.supports.episode : p.supports.movie))
  const [provider, setProvider] = useState<string | null>(null)
  const chosen = provider ?? usable[0]?.id ?? null
  const [languages, setLanguages] = useState(defaultLanguages)
  const [asked, setAsked] = useState<{ provider: string; languages: string } | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [added, setAdded] = useState<string[]>([])

  const details = useQuery({
    queryKey: ['catalog-title', title?.mediaType, title?.tmdbId],
    enabled: !!title,
    staleTime: 60 * 60_000,
    queryFn: () => unwrap(api.GET('/catalog/titles/{mediaType}/{tmdbId}', { params: { path: { mediaType: title!.mediaType, tmdbId: title!.tmdbId } } })),
  })
  const imdbId = details.data?.imdbId ?? null

  const results = useQuery({
    queryKey: ['subtitle-search', asked, imdbId, title?.season, title?.episode],
    enabled: !!asked && !!imdbId,
    queryFn: () =>
      unwrap(
        api.GET('/subtitles/search', {
          params: {
            query: {
              provider: asked!.provider,
              imdb_id: imdbId!,
              ...(episode ? { season: title!.season!, episode: title!.episode! } : {}),
              languages: asked!.languages || undefined,
            },
          },
        }),
      ),
  })

  const search = (e: FormEvent) => {
    e.preventDefault()
    if (chosen) setAsked({ provider: chosen, languages: languages.replace(/\s+/g, '') })
  }

  const pick = async (s: Schemas['SubtitleSearch']['subtitles'][number]) => {
    setAdding(s.ref)
    try {
      const q = new URLSearchParams({ provider: s.provider, ref: s.ref, lang: s.language })
      const text = await fetchVtt(`${API_PREFIX}/subtitles/file?${q}`)
      const providerName = providers.data?.find((p) => p.id === s.provider)?.name ?? s.provider
      onAdd(text, { label: s.languageName ?? s.language, detail: [s.name, providerName].filter(Boolean).join(' · '), language: s.language, origin: 'online' })
      setAdded((a) => [...a, s.ref])
    } catch (err) {
      toast.error('Couldn’t get these subtitles', { description: errorMessage(err) })
    } finally {
      setAdding(null)
    }
  }

  let body: ReactNode
  if (!title) {
    body = (
      <p className="text-xs text-muted-foreground">
        Playpex doesn’t know which title this file is, so it can’t search for it.{' '}
        {fileId ? (
          <Link className="text-primary underline-offset-4 hover:underline" to={`/library?file=${fileId}`}>
            Match it in the Library
          </Link>
        ) : (
          'Add a file instead.'
        )}
      </p>
    )
  } else if (providers.isPending || details.isPending) {
    body = <Spinner className="text-muted-foreground" />
  } else if (!usable.length) {
    body = <p className="text-xs text-muted-foreground">No subtitle provider is set up for {episode ? 'episodes' : 'movies'}. Settings › Subtitles adds keys.</p>
  } else if (!imdbId) {
    body = <p className="text-xs text-muted-foreground">TMDB has no IMDb id for this title: the providers find subtitles by it.</p>
  } else {
    body = (
      <>
        <form onSubmit={search} className="space-y-2">
          <div className="flex gap-2">
            <Select value={chosen ?? ''} onValueChange={setProvider}>
              <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="Provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {usable.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={languages}
              onChange={(e) => setLanguages(e.target.value)}
              aria-label="Languages (codes, comma separated)"
              title="Languages: ISO codes, comma separated (en,fr,ar)"
              placeholder="en,fr"
              className="h-8 w-24"
            />
          </div>
          <Button type="submit" size="sm" className="w-full" disabled={results.isFetching}>
            {results.isFetching ? <Spinner /> : <Search />} Search {title.title ?? 'this title'}
            {episode ? ` ${`S${String(title.season).padStart(2, '0')}E${String(title.episode).padStart(2, '0')}`}` : ''}
          </Button>
        </form>
        {results.error && <p className="text-xs text-destructive">{errorMessage(results.error)}</p>}
        {results.data &&
          (results.data.subtitles.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {results.data.unsupported ? 'This provider doesn’t cover this kind of title.' : 'Nothing found in these languages. Try another provider.'}
            </p>
          ) : (
            <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
              {results.data.subtitles.map((s) => (
                <li key={s.ref}>
                  <button
                    type="button"
                    disabled={!!adding}
                    onClick={() => pick(s)}
                    className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm hover:bg-muted disabled:opacity-60"
                  >
                    <span className="w-8 shrink-0 text-xs font-medium text-muted-foreground uppercase">{s.language}</span>
                    <span className="min-w-0 flex-1 truncate text-xs" title={s.name ?? undefined}>
                      {s.name ?? s.languageName ?? s.language}
                    </span>
                    {adding === s.ref ? <Spinner /> : added.includes(s.ref) ? <Check className="size-4 text-primary" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </>
    )
  }

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Globe className="size-3.5" /> Find online
      </h3>
      {body}
    </section>
  )
}

// A subtitle file anywhere in the server's storage: the video's folder first
function ServerPicker({
  open,
  onOpenChange,
  place: startPlace,
  dir: startDir,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  place?: string
  dir?: string
  onPick: (text: string, name: string) => void
}) {
  const places = useQuery({ queryKey: ['storage-places'], queryFn: () => unwrap(api.GET('/admin/storage/places')), enabled: open })
  const online = (places.data?.places ?? []).filter((p) => p.status === 'online')
  const [place, setPlace] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  // `downloads`: the download folder, whatever its place is called
  const start = online.find((p) => p.id === startPlace || (startPlace === 'downloads' && p.kind === 'downloads'))?.id ?? null
  const current = place ?? start ?? online[0]?.id ?? null
  const at = path ?? (place === null && current === start ? (startDir ?? '') : '')
  const listing = useQuery({
    queryKey: ['storage-browse', current, at, 'name', ''],
    enabled: open && !!current,
    placeholderData: keepPreviousData,
    queryFn: () => unwrap(api.GET('/admin/storage/browse', { params: { query: { place: current!, path: at, sort: 'name' } } })),
  })
  const entries = (listing.data?.entries ?? []).filter((e) => e.type === 'folder' || SUBTITLE_FILE.test(e.name))
  const name = online.find((p) => p.id === current)?.name ?? ''

  const read = async (entryPath: string, entryName: string) => {
    setReading(entryPath)
    try {
      const q = new URLSearchParams({ place: current!, path: entryPath })
      onPick(await fetchVtt(`${API_PREFIX}/admin/storage/subtitle?${q}`), entryName)
    } catch (err) {
      toast.error(`Couldn’t read ${entryName}`, { description: errorMessage(err) })
    } finally {
      setReading(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Subtitles from the server</DialogTitle>
          <DialogDescription>An SRT, ASS, SSA or WebVTT file in one of the Library’s places.</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-2">
          <Select
            value={current ?? ''}
            onValueChange={(v) => {
              setPlace(v)
              setPath('')
            }}
          >
            <SelectTrigger className="w-full" aria-label="Place">
              <SelectValue placeholder="Choose a place" />
            </SelectTrigger>
            <SelectContent>
              {online.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <nav aria-label="Folder" className="flex min-w-0 items-center gap-0.5 text-sm text-muted-foreground">
            <button type="button" className="shrink-0 rounded px-1 hover:bg-muted hover:text-foreground" onClick={() => setPath('')}>
              {name}
            </button>
            {at
              .split('/')
              .filter(Boolean)
              .map((c, i, all) => (
                <span key={i} className="flex min-w-0 items-center gap-0.5">
                  <ChevronRight className="size-3.5 shrink-0" />
                  <button type="button" className="truncate rounded px-1 hover:bg-muted hover:text-foreground" onClick={() => setPath(all.slice(0, i + 1).join('/'))}>
                    {c}
                  </button>
                </span>
              ))}
          </nav>
          <div className={cn('h-72 overflow-y-auto rounded-md border', listing.isPlaceholderData && 'opacity-60')}>
            {listing.error ? (
              <p className="p-3 text-sm text-destructive">{errorMessage(listing.error)}</p>
            ) : listing.isPending ? (
              <div className="p-3">
                <Spinner className="text-muted-foreground" />
              </div>
            ) : (
              <ul className="text-sm">
                {listing.data?.parent !== null && listing.data?.parent !== undefined && (
                  <li>
                    <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted" onClick={() => setPath(listing.data!.parent!)}>
                      <ArrowUp className="size-4 text-muted-foreground" /> ..
                    </button>
                  </li>
                )}
                {entries.map((e) => (
                  <li key={e.path}>
                    <button
                      type="button"
                      disabled={!!reading}
                      className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left hover:bg-muted disabled:opacity-60"
                      onClick={() => (e.type === 'folder' ? setPath(e.path) : read(e.path, e.name))}
                    >
                      {e.type === 'folder' ? <Folder className="size-4 shrink-0 text-primary" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0 flex-1 truncate">{e.name}</span>
                      {reading === e.path && <Spinner />}
                    </button>
                  </li>
                ))}
                {entries.length === 0 && <li className="px-3 py-2 text-muted-foreground">No subtitle files or folders here.</li>}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
