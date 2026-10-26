import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownWideNarrow,
  ChevronRight,
  Copy,
  Download,
  File as FileIcon,
  FileVideo,
  Folder,
  HardDrive,
  Info,
  MoreHorizontal,
  Play,
  Search,
  Subtitles,
  Trash2,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, QueryError } from '@/components/common'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { ago, bytes, clock, dateTime } from '@/lib/format'
import { episodeCode, tmdbImage } from '@/lib/media'
import { usePlayer } from '@/lib/player'
import { cn } from '@/lib/utils'

// A place of the Library as the server's files (docs/dashboard-plan.md §6):
// one level at a time, each file with what it is to Playpex (its title, its
// poster, its quality and length; a folder holding one title shows it too),
// its actions (play, its details and match, its download, delete), the disk
// under the place and its largest folders.

export type Place = Schemas['StoragePlaces']['places'][number]
type Entry = Schemas['StorageEntry']

const WHAT_TONE: Record<string, string> = {
  matched: 'text-muted-foreground',
  unmatched: 'text-warning',
  ignored: 'text-muted-foreground',
  missing: 'text-destructive',
  downloading: 'text-down',
  subtitles: 'text-muted-foreground',
  video: 'text-muted-foreground',
  other: 'text-muted-foreground',
}

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg)$/i
const SUBTITLE = /\.(srt|ass|ssa|vtt|sub|idx|sup)$/i

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success('Path copied'),
    () => toast.error('Couldn’t copy the path'),
  )
}

/** "Heat (1995)" / "Breaking Bad · S02E04 · Down" / "Breaking Bad (2008) · 12 episodes" */
function mediaLine(m: NonNullable<Entry['media']>): string {
  const name = m.title ?? `TMDB ${m.tmdbId}`
  if (m.season !== null && m.episode !== null) return [name, episodeCode(m.season, m.episode), m.episodeTitle].filter(Boolean).join(' · ')
  return `${name}${m.year ? ` (${m.year})` : ''}${m.episodes ? ` · ${m.episodes} ${m.episodes === 1 ? 'episode' : 'episodes'}` : ''}`
}

export function PlaceBrowser({
  place,
  path,
  q,
  onGo,
  onOpenFile,
  header,
}: {
  place: Place
  path: string
  q: string
  onGo: (path: string, q?: string | null) => void
  onOpenFile: (fileId: string) => void
  /** the place's own line: its library folder's facts and actions */
  header?: ReactNode
}) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const player = usePlayer()
  const [sort, setSort] = useState<'name' | 'size' | 'date'>('name')
  const [search, setSearch] = useState(q)
  const [deleting, setDeleting] = useState<Entry | null>(null)
  const listing = useQuery({
    queryKey: ['storage-browse', place.id, path, sort, q],
    queryFn: () => unwrap(api.GET('/admin/storage/browse', { params: { query: { place: place.id, path, sort, q: q || undefined } } })),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.measuring ? 2000 : 15_000),
  })
  const remove = useMutation({
    mutationFn: (e: Entry) => unwrap(api.DELETE('/admin/storage/entries', { body: { place: place.id, path: e.path } })),
    onSuccess: (r, e) => {
      toast.success(`Deleted ${e.name}`, { description: `${bytes(r.freedBytes)} freed` })
      for (const key of ['storage-browse', 'storage-places', 'downloads', 'library', 'library-home', 'library-files']) client.invalidateQueries({ queryKey: [key] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const crumbs = useMemo(() => (path ? path.split('/') : []), [path])
  const full = (rel: string) => (rel ? `${place.root}/${rel}` : place.root)
  const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
  const play = (e: Entry) =>
    player.play({ ref: e.ref!, title: e.media ? mediaLine(e.media) : e.name, detail: place.name, place: place.id, dir: dirOf(e.path) })

  const open = (e: Entry) => {
    if (e.type === 'folder') onGo(e.path)
    else if (e.fileId) onOpenFile(e.fileId)
    else if (e.ref) play(e)
  }

  const actions = (e: Entry): ReactNode[] => {
    const items: ReactNode[] = []
    if (e.ref)
      items.push(
        <DropdownMenuItem key="play" onSelect={() => play(e)}>
          <Play /> Play
        </DropdownMenuItem>,
      )
    if (e.fileId)
      items.push(
        <DropdownMenuItem key="details" onSelect={() => onOpenFile(e.fileId!)}>
          <Info /> {e.what?.kind === 'unmatched' ? 'Match…' : 'Details and match'}
        </DropdownMenuItem>,
      )
    if (e.download)
      items.push(
        <DropdownMenuItem key="download" onSelect={() => navigate(`/downloads?hash=${e.download!.infoHash}`)}>
          <Download /> Show the download
        </DropdownMenuItem>,
      )
    items.push(
      <DropdownMenuItem key="copy" onSelect={() => copy(full(e.path))}>
        <Copy /> Copy path
      </DropdownMenuItem>,
    )
    items.push(<DropdownMenuSeparator key="sep" />)
    items.push(
      <DropdownMenuItem
        key="delete"
        variant="destructive"
        disabled={!!e.download?.active}
        title={e.download?.active ? 'A running torrent writes here: pause it first' : undefined}
        onSelect={() => setDeleting(e)}
      >
        <Trash2 /> Delete…
      </DropdownMenuItem>,
    )
    return items
  }

  const data = listing.data
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl bg-card">
      {header}
      {/* where: the place and its folders, a search, the order */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <nav aria-label="Folder" className="flex min-w-0 flex-1 items-center gap-0.5 text-sm">
          <button type="button" onClick={() => onGo('')} className={cn('shrink-0 rounded px-1.5 py-0.5 hover:bg-muted', !path && !q && 'font-medium')}>
            {place.name}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-0.5">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={() => onGo(crumbs.slice(0, i + 1).join('/'))}
                className={cn('truncate rounded px-1.5 py-0.5 hover:bg-muted', i === crumbs.length - 1 && 'font-medium')}
                title={c}
              >
                {c}
              </button>
            </span>
          ))}
          {q && (
            <span className="flex items-center gap-0.5 text-muted-foreground">
              <ChevronRight className="size-3.5" /> Names with “{q}”
            </span>
          )}
        </nav>
        <form
          className="relative w-full sm:w-52"
          onSubmit={(e) => {
            e.preventDefault()
            onGo(search.trim() ? '' : path, search.trim() || null)
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              if (!e.target.value && q) onGo('', null)
            }}
            placeholder={`Find in ${place.name}`}
            aria-label={`Find in ${place.name}`}
            className="h-8 pl-9"
          />
        </form>
        <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
          <SelectTrigger size="sm" className="w-32" aria-label="Order">
            <ArrowDownWideNarrow className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name">By name</SelectItem>
            <SelectItem value="size">Largest first</SelectItem>
            <SelectItem value="date">Newest first</SelectItem>
          </SelectContent>
        </Select>
        <Largest place={place} onGo={onGo} />
      </div>

      {listing.isPending ? (
        <div className="p-4">
          <Loading rows={4} />
        </div>
      ) : listing.error ? (
        <div className="p-4">
          <QueryError error={listing.error} title="Could not open this folder" />
        </div>
      ) : data && data.entries.length === 0 ? (
        <div className="p-6">
          <Empty icon={<Folder />} title={q ? `Nothing named “${q}”` : 'An empty folder'}>
            {q ? 'No file or folder of this place has every word of the search in its name.' : null}
          </Empty>
        </div>
      ) : data ? (
        <div className={cn('overflow-x-auto', listing.isPlaceholderData && 'opacity-60')}>
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead className="text-xs text-muted-foreground">
              <tr className="[&>th]:border-b [&>th]:px-2 [&>th]:py-2 [&>th]:font-medium [&>th]:whitespace-nowrap">
                <th className="pl-3 text-left">Name</th>
                <th className="hidden text-left md:table-cell">What it is</th>
                <th className="hidden text-right sm:table-cell">Length</th>
                <th className="text-right">Size</th>
                <th className="hidden text-right lg:table-cell">Modified</th>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {data.parent !== null && !q && (
                <tr className="cursor-pointer hover:bg-muted/50 [&>td]:border-b" onClick={() => onGo(data.parent ?? '')}>
                  <td className="py-1.5 pl-3 text-muted-foreground" colSpan={6}>
                    <span className="flex items-center gap-2">
                      <span className="flex w-7 justify-center">
                        <Folder className="size-4" />
                      </span>
                      ..
                    </span>
                  </td>
                </tr>
              )}
              {data.entries.map((e) => (
                <EntryRow key={e.path} entry={e} showPath={!!q} onOpen={() => open(e)} onPlay={e.ref ? () => play(e) : undefined} actions={actions(e)} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <DiskLine place={place} here={data?.bytes ?? null} measuring={!!data?.measuring} path={path} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.type === 'folder' ? 'this folder' : 'this file'}?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-xs break-all text-foreground">{deleting ? full(deleting.path) : ''}</span>
              <br />
              {deleting?.type === 'folder' ? 'Everything in it is deleted from the disk' : 'It is deleted from the disk'}
              {deleting?.fileId || deleting?.type === 'folder' ? ', and the Library forgets it' : ''}
              {deleting?.download ? '. The download it belongs to is forgotten too (playing it again downloads it again)' : ''}. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) remove.mutate(deleting)
                setDeleting(null)
              }}
            >
              Delete {deleting?.bytes ? `(${bytes(deleting.bytes)})` : ''}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// A row's picture: a poster when it is (or holds) one title, else what kind of entry it is
function Thumb({ entry: e }: { entry: Entry }) {
  const poster = tmdbImage(e.media?.posterPath, 'w92')
  if (poster)
    return <img src={poster} alt="" loading="lazy" className="aspect-2/3 w-7 shrink-0 rounded-[3px] bg-muted object-cover ring-1 ring-border" />
  const Icon = e.type === 'folder' ? Folder : VIDEO.test(e.name) ? FileVideo : SUBTITLE.test(e.name) ? Subtitles : FileIcon
  return (
    <span className="flex w-7 shrink-0 justify-center">
      <Icon className={cn('size-4', e.type === 'folder' ? 'text-foreground' : 'text-muted-foreground')} />
    </span>
  )
}

function EntryRow({
  entry: e,
  showPath,
  onOpen,
  onPlay,
  actions,
}: {
  entry: Entry
  showPath: boolean
  onOpen: () => void
  onPlay?: () => void
  actions: ReactNode[]
}) {
  const clickable = e.type === 'folder' || !!e.ref || !!e.fileId
  // a second line: the title it is, or how many a folder holds
  const sub = e.media
    ? mediaLine(e.media)
    : e.type === 'folder' && e.titles
      ? `${e.titles} titles`
      : e.what && e.what.kind !== 'matched'
        ? e.what.text
        : null
  return (
    <tr
      className={cn('group/row hover:bg-muted/50 [&>td]:border-b', clickable && 'cursor-pointer')}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={(ev) => {
        if (clickable && ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault()
          onOpen()
        }
      }}
      tabIndex={clickable ? 0 : undefined}
    >
      <td className="max-w-0 py-1.5 pr-2 pl-3 [width:100%]">
        <div className="flex min-w-0 items-center gap-2">
          <Thumb entry={e} />
          <div className="min-w-0">
            <div className="truncate" title={e.name}>
              {e.name}
            </div>
            {showPath && <div className="truncate text-xs text-muted-foreground">{e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '/'}</div>}
            {sub && <div className={cn('truncate text-xs md:hidden', e.what ? WHAT_TONE[e.what.kind] : 'text-muted-foreground')}>{sub}</div>}
          </div>
        </div>
      </td>
      <td className="hidden max-w-72 min-w-40 px-2 whitespace-nowrap md:table-cell">
        {e.media ? (
          <span className="block truncate" title={mediaLine(e.media)}>
            {mediaLine(e.media)}
            {e.quality && <span className="ml-1.5 text-xs text-muted-foreground">{e.quality}</span>}
          </span>
        ) : e.type === 'folder' && e.titles ? (
          <span className="text-muted-foreground">{e.titles} titles</span>
        ) : e.what ? (
          <span className={cn('block truncate', WHAT_TONE[e.what.kind])} title={e.what.text}>
            {e.what.text}
          </span>
        ) : e.download ? (
          <span className="block truncate text-muted-foreground">{e.download.active ? 'A download, running' : 'A download'}</span>
        ) : null}
      </td>
      <td className="hidden px-2 text-right whitespace-nowrap text-muted-foreground sm:table-cell">{e.duration ? clock(e.duration) : ''}</td>
      <td className="px-2 text-right whitespace-nowrap tabular-nums">
        {e.bytes === null ? <span className="text-xs text-muted-foreground">measuring…</span> : bytes(e.bytes)}
        {e.type === 'folder' && e.items !== null && (
          <div className="text-xs text-muted-foreground">
            {e.items} {e.items === 1 ? 'item' : 'items'}
          </div>
        )}
      </td>
      <td className="hidden px-2 text-right whitespace-nowrap text-muted-foreground lg:table-cell" title={dateTime(e.modifiedAt)}>
        {ago(e.modifiedAt)}
      </td>
      <td className="pr-2 text-right whitespace-nowrap" onClick={(ev) => ev.stopPropagation()}>
        {onPlay && (
          <Button variant="ghost" size="icon-sm" aria-label={`Play ${e.name}`} title="Play" className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100" onClick={onPlay}>
            <Play />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${e.name}`} className="opacity-60 group-hover/row:opacity-100 aria-expanded:opacity-100">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {actions}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  )
}

// The disk under the place: how full, and what Playpex holds there
function DiskLine({ place, here, measuring, path }: { place: Place; here: number | null; measuring: boolean; path: string }) {
  if (!place.disk) return null
  const used = place.disk.total - place.disk.free
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground tabular-nums">
      <span className="flex items-center gap-1.5">
        <HardDrive className="size-3.5" />
        Disk: <span className="text-foreground">{bytes(used)}</span> used of {bytes(place.disk.total)}
      </span>
      <span className="h-1 w-32 overflow-hidden rounded-full bg-(--strip-track)">
        <span className="block h-full rounded-full bg-muted-foreground/60" style={{ width: `${(used / place.disk.total) * 100}%` }} />
      </span>
      <span>
        {measuring ? 'Measuring this place…' : `${path ? 'This folder holds' : 'Playpex holds'} ${bytes(path ? here : place.bytes)} here`}
      </span>
      <span className="ml-auto hidden truncate font-mono sm:inline" title={place.root}>
        {place.root}
      </span>
    </div>
  )
}

// The place's biggest title folders, one click away
function Largest({ place, onGo }: { place: Place; onGo: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const largest = useQuery({
    queryKey: ['storage-largest', place.id],
    queryFn: () => unwrap(api.GET('/admin/storage/largest', { params: { query: { place: place.id } } })),
    enabled: open,
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          Largest folders
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1">
        <p className="px-2 py-1.5 text-sm font-medium">What takes the space in {place.name}</p>
        {largest.isPending ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
        ) : largest.data?.measuring ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">Still measuring this place. Try again in a moment.</p>
        ) : !largest.data?.folders.length ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">No folders here.</p>
        ) : (
          <ul>
            {largest.data.folders.map((f) => {
              const top = largest.data!.folders[0].bytes
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                    onClick={() => {
                      setOpen(false)
                      onGo(f.path)
                    }}
                  >
                    <span className="flex w-full items-baseline gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate" title={f.path}>
                        {f.path.split('/').pop()}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">{bytes(f.bytes)}</span>
                    </span>
                    <span className="h-1 w-full overflow-hidden rounded-full bg-(--strip-track)">
                      <span className="block h-full rounded-full bg-muted-foreground/50" style={{ width: `${(f.bytes / top) * 100}%` }} />
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

// Today's "Clear": the download folder's entries no running torrent uses
export function CleanUp() {
  const client = useQueryClient()
  const storage = useQuery({ queryKey: ['storage'], queryFn: () => unwrap(api.GET('/admin/storage')), refetchInterval: 30_000 })
  const clear = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/storage/clear')),
    onSuccess: (r) => {
      toast.success(`Cleaned up: ${r.removed} ${r.removed === 1 ? 'download' : 'downloads'} deleted, ${bytes(r.freedBytes)} freed`)
      for (const key of ['storage', 'storage-places', 'storage-browse', 'downloads', 'overview']) client.invalidateQueries({ queryKey: [key] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const idle = storage.data?.items.filter((i) => !i.infoHash) ?? []
  const idleBytes = idle.reduce((sum, i) => sum + i.bytes, 0)
  return (
    <Confirm
      title="Clean up the download folder?"
      description={`${idle.length} ${idle.length === 1 ? 'download' : 'downloads'} (${bytes(idleBytes)}) that no running torrent uses are deleted from the download folder, and the server forgets them. Playing them later downloads them again.`}
      action="Delete them"
      onConfirm={() => clear.mutate()}
      trigger={
        <Button variant="outline" disabled={!idle.length || clear.isPending} title={idle.length ? undefined : 'Nothing to clean up'}>
          <Trash2 /> Clean up downloads {idle.length ? `(${bytes(idleBytes)})` : ''}
        </Button>
      }
    />
  )
}
