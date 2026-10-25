import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownWideNarrow,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  File as FileIcon,
  FileVideo,
  Folder,
  HardDrive,
  MoreHorizontal,
  Play,
  Search,
  Subtitles,
  Trash2,
  Tv,
  Wand2,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, QueryError } from '@/components/common'
import { usePlayer } from '@/components/player'
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
import { ago, bytes, dateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

// Storage as the server's files (docs/dashboard-plan.md §6, step 6): every
// place Playpex keeps media (the download folder, the library's folders) one
// level at a time, what each file is to Playpex, its actions (play, open it in
// the Library, its download, delete), the disk under the place and its largest
// folders. The URL keeps the place, the folder and the search (?place=&path=&q=).
// Folder settings stay on the Library page; Storage is files and space.

type Place = Schemas['StoragePlaces']['places'][number]
type Entry = Schemas['StorageEntry']

const KIND_ICON: Record<Place['kind'], typeof Folder> = {
  downloads: Download,
  movies: Clapperboard,
  shows: Tv,
  mixed: Folder,
  other: Folder,
}

const WHAT_TONE: Record<string, string> = {
  matched: 'text-foreground',
  unmatched: 'text-warning',
  ignored: 'text-muted-foreground',
  missing: 'text-destructive',
  downloading: 'text-down',
  subtitles: 'text-muted-foreground',
  video: 'text-muted-foreground',
  other: 'text-muted-foreground',
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success('Path copied'),
    () => toast.error('Couldn’t copy the path'),
  )
}

export function StoragePage() {
  const [params, setParams] = useSearchParams()
  const places = useQuery({
    queryKey: ['storage-places'],
    queryFn: () => unwrap(api.GET('/admin/storage/places')),
    // sizes arrive once a place is measured
    refetchInterval: (q) => (q.state.data?.places.some((p) => p.measuring) ? 2000 : 30_000),
  })
  const list = places.data?.places ?? []
  const current = list.find((p) => p.id === params.get('place')) ?? list.find((p) => p.status === 'online') ?? null
  const path = params.get('path') ?? ''
  const go = (place: string, to = '', q: string | null = null) =>
    setParams((p) => {
      const next = new URLSearchParams(p)
      next.set('place', place)
      if (to) next.set('path', to)
      else next.delete('path')
      if (q) next.set('q', q)
      else next.delete('q')
      return next
    })

  if (places.isPending) return <Loading />
  if (places.error) return <QueryError error={places.error} />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">Storage</h1>
        <Button variant="outline" asChild>
          <Link to="/library">Library folders</Link>
        </Button>
        <CleanUp />
      </div>

      <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
        {/* places: a rail on desktop, a select on phones */}
        <nav aria-label="Places" className="hidden flex-col gap-1 md:flex">
          <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">This server</p>
          {list.map((p) => (
            <PlaceItem key={p.id} place={p} active={current?.id === p.id} onClick={() => go(p.id)} />
          ))}
        </nav>
        <div className="md:hidden">
          <Select value={current?.id ?? ''} onValueChange={(v) => go(v)}>
            <SelectTrigger className="w-full" aria-label="Place">
              <SelectValue placeholder="Choose a place" />
            </SelectTrigger>
            <SelectContent>
              {list.map((p) => (
                <SelectItem key={p.id} value={p.id} disabled={p.status === 'offline'}>
                  {p.name} {p.bytes !== null ? `· ${bytes(p.bytes)}` : ''} {p.status === 'offline' ? '(offline)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {current ? (
          current.status === 'offline' ? (
            <Empty icon={<HardDrive />} title={`${current.name} is offline`}>
              <span className="font-mono text-xs break-all">{current.root}</span> isn’t there: a drive unplugged or a share not mounted. Its files stay in
              the library while it’s away.
            </Empty>
          ) : (
            <Browser key={current.id} place={current} path={path} q={params.get('q') ?? ''} onGo={(to, q) => go(current.id, to, q)} />
          )
        ) : (
          <Empty icon={<HardDrive />} title="No places">
            Add a library folder, or download something: its folder shows here.
          </Empty>
        )}
      </div>
    </div>
  )
}

function PlaceItem({ place, active, onClick }: { place: Place; active: boolean; onClick: () => void }) {
  const Icon = KIND_ICON[place.kind]
  const used = place.disk ? 1 - place.disk.free / place.disk.total : null
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group flex flex-col gap-1.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted',
        active && 'bg-muted shadow-[inset_2px_0_0_var(--primary)]',
      )}
    >
      <span className="flex items-center gap-2 text-sm">
        <Icon className={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')} />
        <span className={cn('min-w-0 flex-1 truncate', active ? 'font-medium' : 'text-muted-foreground group-hover:text-foreground')}>{place.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {place.status === 'offline' ? 'offline' : place.measuring ? 'measuring…' : bytes(place.bytes)}
        </span>
      </span>
      {used !== null && place.status === 'online' && (
        <span className="flex items-center gap-2 pl-6" title={`${bytes(place.disk!.free)} free of ${bytes(place.disk!.total)}`}>
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-(--strip-track)">
            <span className={cn('block h-full rounded-full', used > 0.9 ? 'bg-destructive' : 'bg-muted-foreground/50')} style={{ width: `${used * 100}%` }} />
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">{bytes(place.disk!.free)} free</span>
        </span>
      )}
    </button>
  )
}

function Browser({ place, path, q, onGo }: { place: Place; path: string; q: string; onGo: (path: string, q?: string | null) => void }) {
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
      client.invalidateQueries({ queryKey: ['storage-browse'] })
      client.invalidateQueries({ queryKey: ['storage-places'] })
      client.invalidateQueries({ queryKey: ['downloads'] })
      client.invalidateQueries({ queryKey: ['library'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const crumbs = useMemo(() => (path ? path.split('/') : []), [path])
  const full = (rel: string) => (rel ? `${place.root}/${rel}` : place.root)

  const actions = (e: Entry): ReactNode[] => {
    const items: ReactNode[] = []
    if (e.ref)
      items.push(
        <DropdownMenuItem key="play" onSelect={() => player.play({ ref: e.ref!, title: e.name, detail: place.name })}>
          <Play /> Play here
        </DropdownMenuItem>,
      )
    if (e.fileId)
      items.push(
        <DropdownMenuItem key="library" onSelect={() => navigate(`/library?file=${e.fileId}`)}>
          <Wand2 /> {e.what?.kind === 'unmatched' ? 'Match in the Library' : 'Open in the Library'}
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
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
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
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              if (!e.target.value && q) onGo('', null)
            }}
            placeholder={`Find in ${place.name}`}
            aria-label={`Find in ${place.name}`}
            className="h-8 pl-8"
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
                <th className="text-right">Size</th>
                <th className="hidden text-left md:table-cell">What it is</th>
                <th className="hidden text-right lg:table-cell">Modified</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {data.parent !== null && !q && (
                <tr className="cursor-pointer hover:bg-muted/50 [&>td]:border-b" onClick={() => onGo(data.parent ?? '')}>
                  <td className="py-1.5 pl-3 text-muted-foreground" colSpan={5}>
                    <span className="flex items-center gap-2">
                      <Folder className="size-4" /> ..
                    </span>
                  </td>
                </tr>
              )}
              {data.entries.map((e) => (
                <EntryRow
                  key={e.path}
                  entry={e}
                  showPath={!!q}
                  onOpen={() => (e.type === 'folder' ? onGo(e.path) : e.ref ? player.play({ ref: e.ref, title: e.name, detail: place.name }) : undefined)}
                  actions={actions(e)}
                />
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

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg)$/i
const SUBTITLE = /\.(srt|ass|ssa|vtt|sub|idx|sup)$/i

function EntryRow({ entry: e, showPath, onOpen, actions }: { entry: Entry; showPath: boolean; onOpen: () => void; actions: ReactNode[] }) {
  const Icon = e.type === 'folder' ? Folder : VIDEO.test(e.name) ? FileVideo : SUBTITLE.test(e.name) ? Subtitles : FileIcon
  const clickable = e.type === 'folder' || !!e.ref
  return (
    <tr
      className={cn('group/row hover:bg-muted/50 [&>td]:border-b', clickable && 'cursor-pointer')}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={(ev) => {
        if (clickable && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault()
          onOpen()
        }
      }}
      tabIndex={clickable ? 0 : undefined}
    >
      <td className="max-w-0 py-1.5 pl-3 pr-2 [width:100%]">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn('size-4 shrink-0', e.type === 'folder' ? 'text-primary' : 'text-muted-foreground')} />
          <div className="min-w-0">
            <div className="truncate" title={e.name}>
              {e.name}
            </div>
            {showPath && <div className="truncate text-xs text-muted-foreground">{e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '/'}</div>}
            {e.what && <div className={cn('truncate text-xs md:hidden', WHAT_TONE[e.what.kind])}>{e.what.text}</div>}
          </div>
          {e.type === 'file' && e.ref && <Play className="ml-auto size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100" aria-hidden />}
        </div>
      </td>
      <td className="px-2 text-right whitespace-nowrap tabular-nums">
        {e.bytes === null ? <span className="text-xs text-muted-foreground">measuring…</span> : bytes(e.bytes)}
        {e.type === 'folder' && e.items !== null && (
          <div className="text-xs text-muted-foreground">
            {e.items} {e.items === 1 ? 'item' : 'items'}
          </div>
        )}
      </td>
      <td className="hidden max-w-64 px-2 md:table-cell">
        {e.what ? (
          <span className={cn('block truncate', WHAT_TONE[e.what.kind])} title={e.what.text}>
            {e.what.kind === 'matched' && <span className="mr-1 text-up">✓</span>}
            {e.what.text}
          </span>
        ) : e.download ? (
          <span className="text-muted-foreground">{e.download.active ? 'A download, running' : 'A download'}</span>
        ) : null}
      </td>
      <td className="hidden px-2 text-right whitespace-nowrap text-muted-foreground lg:table-cell" title={dateTime(e.modifiedAt)}>
        {ago(e.modifiedAt)}
      </td>
      <td className="pr-2 text-right" onClick={(ev) => ev.stopPropagation()}>
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
function CleanUp() {
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
