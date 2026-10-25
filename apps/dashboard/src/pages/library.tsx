import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Tv,
  Undo2,
  Wand2,
} from 'lucide-react'
import { usePlayer } from '@/components/player'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, Mono, PageHeader, QueryError, Spinner } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { useEvent } from '@/lib/events'
import { ago, bytes, clock, dateTime } from '@/lib/format'

// The media library (docs/media-server-plan.md §5.1–5.3): the admin's folders
// (added with a server-side folder browser), scans (live through the
// `library.scan` event), and the files with their TMDB matches, fixed by hand
// here (an admin's match survives rescans).

type LibraryView = Schemas['LibraryView']
type LibraryFolder = Schemas['LibraryFolder']
type LibraryFile = Schemas['LibraryFile']
type LibraryItem = Schemas['LibraryItem']
type FolderKind = Schemas['LibraryFolderKind']
type Audience = Schemas['LibraryAudience']
type FileState = Schemas['LibraryFileState']
type ScanEvent = Schemas['LibraryScanEvent']

/** What the path says (lib/library/parse.js) */
interface Parsed {
  kind?: 'movie' | 'episode'
  title?: string | null
  year?: number | null
  season?: number | null
  episode?: number | null
  episodeEnd?: number | null
  resolution?: string | null
  source?: string | null
  codec?: string | null
}

const KINDS: { id: FolderKind; label: string; hint: string }[] = [
  { id: 'movies', label: 'Movies', hint: 'Every file is matched as a movie' },
  { id: 'shows', label: 'TV shows', hint: 'Every file is matched as an episode (Show/Season 1/…)' },
  { id: 'mixed', label: 'Mixed', hint: 'Movies and episodes, told apart by their names' },
  { id: 'other', label: 'Other videos', hint: 'Never matched: home videos, clips' },
]

const AUDIENCES: { id: Audience; label: string; hint: string }[] = [
  { id: 'everyone', label: 'Everyone', hint: 'Every profile' },
  { id: 'adults', label: 'Adults only', hint: 'Never for kids profiles' },
]

const FILTERS: { id: FileState | 'all'; label: string }[] = [
  { id: 'unmatched', label: 'Unmatched' },
  { id: 'all', label: 'All' },
  { id: 'missing', label: 'Missing' },
  { id: 'ignored', label: 'Ignored' },
]

const PAGE = 100
const TMDB_IMAGES = 'https://image.tmdb.org/t/p/'

const kindLabel = (kind: FolderKind) => KINDS.find((k) => k.id === kind)?.label ?? kind
const pad = (n: number | null | undefined) => String(n ?? 0).padStart(2, '0')
const fileName = (relPath: string) => relPath.slice(relPath.lastIndexOf('/') + 1)

/** "Breaking Bad · S02E04 · Down" / "Heat (1995)" */
function itemLabel(item: LibraryItem): string {
  if (item.kind === 'episode') {
    return [item.title ?? `TMDB ${item.showTmdbId}`, `S${pad(item.season)}E${pad(item.episode)}`, item.episodeTitle]
      .filter(Boolean)
      .join(' · ')
  }
  return (item.title ?? `TMDB ${item.tmdbId}`) + (item.year ? ` (${item.year})` : '')
}

function quality(file: LibraryFile): string | null {
  const p = file.probe
  if (!p?.height) return (file.parse as Parsed | null)?.resolution ?? null
  const res = p.height >= 2000 ? '4K' : p.height >= 1000 ? '1080p' : p.height >= 700 ? '720p' : `${p.height}p`
  return [res, p.hdr ? 'HDR' : null, p.video].filter(Boolean).join(' · ')
}

function useLibrary() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['library'],
    queryFn: () => unwrap(api.GET('/admin/library')),
    refetchInterval: 30_000,
  })
  // progress every 25 files: patched in place; the end of a scan refreshes counts and files
  useEvent<ScanEvent>('library.scan', (e) => {
    if (e.data.state === 'scanning') {
      client.setQueryData<LibraryView>(['library'], (view) =>
        view && {
          ...view,
          scan: { ...view.scan, current: e.data },
          folders: view.folders.map((f) => ({ ...f, scanning: f.id === e.data.folderId, queued: f.id === e.data.folderId ? false : f.queued })),
        },
      )
      return
    }
    client.invalidateQueries({ queryKey: ['library'] })
    client.invalidateQueries({ queryKey: ['library-files'] })
    client.invalidateQueries({ queryKey: ['library-file'] })
  })
  return query
}

function useScan() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: { folderId?: string; force?: boolean }) => unwrap(api.POST('/admin/library/scan', { body })),
    onSuccess: (_, body) => {
      toast.success(body.force ? 'Scanning, unmatched files are matched again' : 'Scanning')
      client.invalidateQueries({ queryKey: ['library'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
}

export function LibraryPage() {
  const library = useLibrary()
  const scan = useScan()
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<LibraryFolder | null>(null)
  const openFile = params.get('file')

  if (library.isPending) return <Loading />
  if (library.error) return <QueryError error={library.error} />

  const { folders, scan: status } = library.data
  const totals = folders.reduce(
    (t, f) => ({
      ok: t.ok + f.counts.ok,
      unmatched: t.unmatched + f.counts.unmatched,
      missing: t.missing + f.counts.missing,
      ignored: t.ignored + f.counts.ignored,
    }),
    { ok: 0, unmatched: 0, missing: 0, ignored: 0 },
  )
  const busy = !!status.current || status.queued.length > 0

  return (
    <>
      <PageHeader
        title="Library"
        description={`${totals.ok + totals.unmatched} files on ${folders.length} ${folders.length === 1 ? 'folder' : 'folders'} · ${totals.unmatched} unmatched`}
        actions={
          <>
            <Button variant="outline" disabled={scan.isPending || busy} onClick={() => scan.mutate({})}>
              <RefreshCw className={busy ? 'animate-spin' : undefined} /> Scan all
            </Button>
            <Button onClick={() => setAdding(true)}>
              <FolderPlus /> Add folder
            </Button>
          </>
        }
      />
      <ScanStatus view={library.data} />
      <FolderList
        folders={folders}
        onScan={(folder, force) => scan.mutate({ folderId: folder.id, force })}
        onEdit={setEditing}
        onAdd={() => setAdding(true)}
      />
      {folders.length > 0 && (
        <FileList
          folders={folders}
          totals={totals}
          onOpen={(id) => setParams({ file: id })}
          onRetry={() => scan.mutate({ force: true })}
          retrying={scan.isPending || busy}
        />
      )}
      <AddFolderDialog open={adding} onOpenChange={setAdding} />
      <EditFolderDialog folder={editing} matchers={library.data.matchers} onClose={() => setEditing(null)} />
      <FileSheet id={openFile} folders={folders} onClose={() => setParams({})} />
    </>
  )
}

// ── scans ─────────────────────────────────────────────────────────────────────

function ScanStatus({ view }: { view: LibraryView }) {
  const current = view.scan.current
  if (!current) return null
  const folder = view.folders.find((f) => f.id === current.folderId)
  const total = current.total ?? 0
  const processed = current.processed ?? 0
  const changes = [
    current.added && `${current.added} new`,
    current.changed && `${current.changed} changed`,
    current.missing && `${current.missing} missing`,
    current.matched && `${current.matched} matched`,
    current.unmatched && `${current.unmatched} unmatched`,
  ].filter(Boolean)
  return (
    <Card size="sm">
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Spinner className="text-primary" />
          <span className="font-medium">Scanning</span>
          {folder && <Mono className="min-w-0 text-muted-foreground">{folder.path}</Mono>}
          {view.scan.queued.length > 0 && <span className="text-muted-foreground">· {view.scan.queued.length} more waiting</span>}
        </div>
        {total > 0 ? (
          <>
            <Progress value={(processed / total) * 100} />
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground tabular-nums">
              <span>
                {processed} / {total} files probed and matched
              </span>
              <span>{changes.join(' · ')}</span>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Looking for new and changed files…</p>
        )}
      </CardContent>
    </Card>
  )
}

// ── folders ───────────────────────────────────────────────────────────────────

function useFolderActions() {
  const client = useQueryClient()
  const refresh = () => {
    client.invalidateQueries({ queryKey: ['library'] })
    client.invalidateQueries({ queryKey: ['library-files'] })
  }
  return {
    refresh,
    remove: useMutation({
      mutationFn: (id: string) => unwrap(api.DELETE('/admin/library/folders/{id}', { params: { path: { id } } })),
      onSuccess: () => {
        toast.success('Folder removed (its files are untouched)')
        refresh()
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  }
}

function folderStatus(folder: LibraryFolder): { text: string; tone: string } | null {
  if (folder.scanning) return { text: 'scanning', tone: 'text-primary' }
  if (folder.queued) return { text: 'waiting to scan', tone: 'text-muted-foreground' }
  if (folder.status === 'missing') return { text: 'unreachable: its files are kept 7 days', tone: 'text-warning' }
  if (folder.status.startsWith('error')) return { text: folder.status, tone: 'text-destructive' }
  return null
}

function FolderList({
  folders,
  onScan,
  onEdit,
  onAdd,
}: {
  folders: LibraryFolder[]
  onScan: (folder: LibraryFolder, force: boolean) => void
  onEdit: (folder: LibraryFolder) => void
  onAdd: () => void
}) {
  const actions = useFolderActions()
  if (!folders.length) {
    return (
      <Empty icon={<FolderOpen />} title="No folders yet">
        Add the folders that hold your movies and shows: the server scans them, matches the files to TMDB and streams them to your
        devices. Files are only read, never moved or deleted.
        <div className="mt-4">
          <Button onClick={onAdd}>
            <FolderPlus /> Add folder
          </Button>
        </div>
      </Empty>
    )
  }
  return (
    <Card className="py-0">
      <CardContent className="divide-y px-0">
        {folders.map((folder) => {
          const state = folderStatus(folder)
          const Icon = folder.builtin ? HardDrive : folder.kind === 'shows' ? Tv : folder.kind === 'movies' ? Film : Folder
          return (
            <div key={folder.id} className="flex items-start gap-3 px-4 py-3">
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="truncate font-mono text-sm" title={folder.path}>
                  {folder.path}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {folder.builtin && <Badge variant="secondary">Downloads</Badge>}
                  <Badge variant="outline">{kindLabel(folder.kind)}</Badge>
                  {folder.audience === 'adults' && <Badge variant="outline">Adults only</Badge>}
                  {folder.matcher && <Badge variant="outline">Recognised by {folder.matcher}</Badge>}
                  {folder.dlna && folder.audience === 'everyone' && (
                    <Badge variant="outline" title="TVs and players on the network browse it (when DLNA is on in Settings)">
                      DLNA
                    </Badge>
                  )}
                  <span className="tabular-nums">
                    {folder.counts.ok} matched
                    {folder.counts.unmatched > 0 && ` · ${folder.counts.unmatched} unmatched`}
                    {folder.counts.missing > 0 && ` · ${folder.counts.missing} missing`}
                    {folder.counts.ignored > 0 && ` · ${folder.counts.ignored} ignored`}
                    {` · scanned ${folder.lastScanAt ? ago(folder.lastScanAt) : 'never'}`}
                  </span>
                </div>
                {state && <div className={`text-xs ${state.tone}`}>{state.text}</div>}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Scan"
                  title="Scan for new and changed files"
                  disabled={folder.scanning || folder.queued}
                  onClick={() => onScan(folder, false)}
                >
                  <RefreshCw className={folder.scanning ? 'animate-spin' : undefined} />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="More">
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onEdit(folder)}>
                      <Pencil /> Edit…
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={folder.scanning || folder.queued} onSelect={() => onScan(folder, true)}>
                      <Wand2 /> Scan and match unmatched files again
                    </DropdownMenuItem>
                    {!folder.builtin && (
                      <>
                        <DropdownMenuSeparator />
                        <Confirm
                          trigger={
                            <DropdownMenuItem variant="destructive" onSelect={(e) => e.preventDefault()}>
                              <Trash2 /> Remove…
                            </DropdownMenuItem>
                          }
                          title="Remove this folder from the library?"
                          description={
                            <>
                              {folder.path}: its files leave the library and their matches are forgotten. Nothing is deleted from the
                              disk.
                            </>
                          }
                          action="Remove"
                          onConfirm={() => actions.remove.mutate(folder.id)}
                        />
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function Choice<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: T
  options: { id: T; label: string; hint: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as T)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{options.find((o) => o.id === value)?.hint}</p>
    </div>
  )
}

// "Include in DLNA": TVs browse it without pairing, so never an adults-only folder
function DlnaSwitch({ id, checked, audience, onChange }: { id: string; checked: boolean; audience: Audience; onChange: (v: boolean) => void }) {
  const adults = audience === 'adults'
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="space-y-1">
        <Label htmlFor={id}>Include in DLNA</Label>
        <p className="text-xs text-muted-foreground">
          {adults
            ? 'Adults-only folders are never shown over DLNA: TVs on the network use no profiles or pairing.'
            : 'TVs, consoles and players on the network browse and play it without Playpex (Settings › DLNA turns the DLNA server on).'}
        </p>
      </div>
      <Switch id={id} checked={checked && !adults} disabled={adults} onCheckedChange={onChange} />
    </div>
  )
}

function AddFolderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient()
  const [path, setPath] = useState('')
  const [kind, setKind] = useState<FolderKind>('mixed')
  const [audience, setAudience] = useState<Audience>('everyone')
  const [dlna, setDlna] = useState(false)
  const add = useMutation({
    mutationFn: () => unwrap(api.POST('/admin/library/folders', { body: { path: path.trim(), kind, audience, dlna: dlna && audience === 'everyone' } })),
    onSuccess: (folder) => {
      toast.success(`${folder.path} added, scanning`)
      client.invalidateQueries({ queryKey: ['library'] })
      setPath('')
      setKind('mixed')
      setAudience('everyone')
      setDlna(false)
      onOpenChange(false)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (path.trim()) add.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit} className="min-w-0 space-y-4">
          <DialogHeader>
            <DialogTitle>Add a folder</DialogTitle>
            <DialogDescription>A folder on the server's disks. Its files are read, never changed.</DialogDescription>
          </DialogHeader>
          <FolderBrowser path={path} onChoose={setPath} />
          <div className="space-y-2">
            <Label htmlFor="folder-path">Folder</Label>
            <Input id="folder-path" value={path} placeholder="/srv/media/Movies" className="font-mono" onChange={(e) => setPath(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Choice id="folder-kind" label="Holds" value={kind} options={KINDS} onChange={setKind} />
            <Choice id="folder-audience" label="Who sees it" value={audience} options={AUDIENCES} onChange={setAudience} />
          </div>
          <DlnaSwitch id="folder-dlna" checked={dlna} audience={audience} onChange={setDlna} />
          <DialogFooter>
            <Button type="submit" disabled={add.isPending || !path.trim()}>
              {add.isPending && <Spinner />} Add and scan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Directories on the server (GET /admin/fs: no file names, no hidden folders)
function FolderBrowser({ path, onChoose }: { path: string; onChoose: (path: string) => void }) {
  const [at, setAt] = useState<string | null>(null)
  const listing = useQuery({
    queryKey: ['fs', at],
    queryFn: () => unwrap(api.GET('/admin/fs', { params: { query: at ? { path: at } : {} } })),
    placeholderData: keepPreviousData,
  })
  const go = (next: string) => {
    setAt(next)
    onChoose(next)
  }
  const data = listing.data
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {data?.places.map((p) => (
          <Button key={p.path} type="button" size="xs" variant={path === p.path ? 'secondary' : 'outline'} onClick={() => go(p.path)}>
            {p.name}
          </Button>
        ))}
      </div>
      <div className="h-56 overflow-y-auto rounded-md border">
        {listing.error ? (
          <p className="p-3 text-sm text-destructive">{errorMessage(listing.error)}</p>
        ) : !data?.path ? (
          <p className="p-3 text-sm text-muted-foreground">Start from a place above, or type a path below.</p>
        ) : (
          <ul className="text-sm">
            {data.parent && (
              <li>
                <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted" onClick={() => go(data.parent!)}>
                  <ArrowUp className="size-4 text-muted-foreground" /> ..
                </button>
              </li>
            )}
            {data.dirs.map((d) => (
              <li key={d.path}>
                <button type="button" className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left hover:bg-muted" onClick={() => go(d.path)}>
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{d.name}</span>
                </button>
              </li>
            ))}
            {data.dirs.length === 0 && <li className="px-3 py-1.5 text-muted-foreground">No folders inside.</li>}
          </ul>
        )}
      </div>
    </div>
  )
}

type Matcher = { id: string; name: string }

// The folder's information provider: Playpex's own matching (TMDB), or a plugin's library.match
const TMDB = 'tmdb'

function EditFolderDialog({ folder, matchers, onClose }: { folder: LibraryFolder | null; matchers: Matcher[]; onClose: () => void }) {
  return (
    <Dialog open={!!folder} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>{folder && <EditFolderForm key={folder.id} folder={folder} matchers={matchers} onClose={onClose} />}</DialogContent>
    </Dialog>
  )
}

function EditFolderForm({ folder, matchers, onClose }: { folder: LibraryFolder; matchers: Matcher[]; onClose: () => void }) {
  const client = useQueryClient()
  const [kind, setKind] = useState<FolderKind>(folder.kind)
  const [audience, setAudience] = useState<Audience>(folder.audience)
  const [dlna, setDlna] = useState(folder.dlna)
  const [matcher, setMatcher] = useState(folder.matcher ?? TMDB)
  const providers = [
    { id: TMDB, label: 'Playpex (TMDB)', hint: 'File and folder names, .nfo files, matched on TMDB' },
    ...matchers.map((m) => ({ id: m.id, label: m.name, hint: `The ${m.name} plugin recognises the files; Playpex's own matching when it can't` })),
    // a plugin that was chosen but isn't running now
    ...(folder.matcher && !matchers.some((m) => m.id === folder.matcher)
      ? [{ id: folder.matcher, label: `${folder.matcher} (not running)`, hint: 'Playpex matches the files until the plugin runs again' }]
      : []),
  ]
  const matcherChanged = matcher !== (folder.matcher ?? TMDB)
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH('/admin/library/folders/{id}', {
          params: { path: { id: folder.id } },
          body: {
            kind,
            audience,
            dlna: dlna && audience === 'everyone',
            ...(matcherChanged && { matcher: matcher === TMDB ? null : matcher }),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(
        matcherChanged
          ? 'Saved; its files are matched again by ' + (providers.find((p) => p.id === matcher)?.label ?? matcher)
          : kind !== folder.kind
            ? 'Saved; scan it to match its files as ' + kindLabel(kind).toLowerCase()
            : 'Saved',
      )
      client.invalidateQueries({ queryKey: ['library'] })
      client.invalidateQueries({ queryKey: ['dlna'] })
      onClose()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit folder</DialogTitle>
        <DialogDescription className="font-mono break-all">{folder.path}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Choice id="edit-kind" label="Holds" value={kind} options={KINDS} onChange={setKind} />
        <Choice id="edit-audience" label="Who sees it" value={audience} options={AUDIENCES} onChange={setAudience} />
      </div>
      {kind !== 'other' && (providers.length > 1 || folder.matcher) && (
        <Choice id="edit-matcher" label="Information provider" value={matcher} options={providers} onChange={setMatcher} />
      )}
      <DlnaSwitch id="edit-dlna" checked={dlna} audience={audience} onChange={setDlna} />
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Spinner />} Save
        </Button>
      </DialogFooter>
    </>
  )
}

// ── files ─────────────────────────────────────────────────────────────────────

function FileList({
  folders,
  totals,
  onOpen,
  onRetry,
  retrying,
}: {
  folders: LibraryFolder[]
  totals: Record<FileState, number>
  onOpen: (id: string) => void
  onRetry: () => void
  retrying: boolean
}) {
  const player = usePlayer()
  const [state, setStateRaw] = useState<FileState | 'all'>(totals.unmatched ? 'unmatched' : 'all')
  const [folderId, setFolderIdRaw] = useState('all')
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  // a new filter starts on the first page
  const setState = (value: FileState | 'all') => {
    setStateRaw(value)
    setOffset(0)
  }
  const setFolderId = (value: string) => {
    setFolderIdRaw(value)
    setOffset(0)
  }
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(typed.trim())
      setOffset(0)
    }, 300)
    return () => clearTimeout(t)
  }, [typed])

  const files = useQuery({
    queryKey: ['library-files', state, folderId, q, offset],
    queryFn: () =>
      unwrap(
        api.GET('/admin/library/files', {
          params: {
            query: {
              ...(state !== 'all' && { state }),
              ...(folderId !== 'all' && { folder: folderId }),
              ...(q && { q }),
              limit: PAGE,
              offset,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  })
  const folderPath = useMemo(() => new Map(folders.map((f) => [f.id, f.path])), [folders])
  const count = (id: FileState | 'all') => (id === 'all' ? totals.ok + totals.unmatched + totals.missing + totals.ignored : totals[id])
  const list = files.data?.files ?? []
  const total = files.data?.total ?? 0

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-base font-semibold">Files</h2>
        {state === 'unmatched' && totals.unmatched > 0 && (
          <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry} title="Scan every folder and try to match these files again">
            <Wand2 /> Match again
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={state} onValueChange={(v) => setState(v as FileState | 'all')} className="max-w-full overflow-x-auto [scrollbar-width:none]">
          <TabsList>
            {FILTERS.map((f) => (
              <TabsTrigger key={f.id} value={f.id}>
                {f.label}
                <span className="ml-1 text-muted-foreground tabular-nums">{count(f.id)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {folders.length > 1 && (
          <Select value={folderId} onValueChange={setFolderId}>
            <SelectTrigger className="w-full sm:w-56" aria-label="Folder">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every folder</SelectItem>
              {folders.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="relative w-full sm:ml-auto sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={typed} placeholder="Path or title" className="pl-8" aria-label="Search files" onChange={(e) => setTyped(e.target.value)} />
        </div>
      </div>
      {files.error ? (
        <QueryError error={files.error} title="Could not load the files" />
      ) : files.isPending ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty icon={<Film />} title={q ? 'No file matches this search' : state === 'unmatched' ? 'Every file is matched' : 'No files here'}>
          {state === 'unmatched' && !q ? 'Files the scanner could not match to TMDB show up here, to be matched by hand.' : null}
        </Empty>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead className="hidden md:table-cell">Match</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Quality</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Size</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody className={files.isPlaceholderData ? 'opacity-60' : undefined}>
                {list.map((file) => (
                  <TableRow key={file.id} className="cursor-pointer" onClick={() => onOpen(file.id)}>
                    <TableCell className="w-full max-w-0">
                      <div className="truncate font-medium" title={file.relPath}>
                        {fileName(file.relPath)}
                      </div>
                      <div className="truncate text-xs text-muted-foreground" title={`${folderPath.get(file.folderId)}/${file.relPath}`}>
                        {file.relPath.includes('/') ? file.relPath.slice(0, file.relPath.lastIndexOf('/')) : folderPath.get(file.folderId)}
                      </div>
                      {/* the match, on phones */}
                      <div className="mt-1 md:hidden">
                        <MatchCell file={file} />
                      </div>
                    </TableCell>
                    <TableCell className="hidden max-w-64 md:table-cell">
                      <MatchCell file={file} />
                    </TableCell>
                    <TableCell className="hidden text-right text-xs whitespace-nowrap text-muted-foreground lg:table-cell">
                      {quality(file) ?? '—'}
                    </TableCell>
                    <TableCell className="hidden text-right text-xs whitespace-nowrap tabular-nums sm:table-cell">{bytes(file.size)}</TableCell>
                    <TableCell className="pr-2" onClick={(e) => e.stopPropagation()}>
                      {file.state !== 'missing' && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Play ${fileName(file.relPath)}`}
                          title="Play here"
                          onClick={() => player.play({ ref: file.ref, title: fileName(file.relPath), detail: folderPath.get(file.folderId) })}
                        >
                          <Play />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {total > PAGE && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground tabular-nums">
          <span>
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </span>
          <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  )
}

function MatchCell({ file }: { file: LibraryFile }) {
  if (file.state === 'ignored') return <Badge variant="outline">Ignored</Badge>
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-sm">
      {file.state === 'missing' && <Badge variant="destructive">Missing</Badge>}
      {file.item ? (
        <>
          <span className="truncate" title={itemLabel(file.item)}>
            {itemLabel(file.item)}
          </span>
          {file.matchedBy === 'admin' && (
            <Badge variant="secondary" title="Matched by hand: kept by rescans">
              by hand
            </Badge>
          )}
        </>
      ) : (
        file.state !== 'missing' && <span className="text-warning">Unmatched</span>
      )}
    </div>
  )
}

// ── one file: details, fixing its match ──────────────────────────────────────

function FileSheet({ id, folders, onClose }: { id: string | null; folders: LibraryFolder[]; onClose: () => void }) {
  const client = useQueryClient()
  const player = usePlayer()
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
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
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
            {file.state !== 'missing' && (
              <Button onClick={() => player.play({ ref: file.ref, title: fileName(file.relPath), detail: folder?.path })}>
                <Play /> Play here
              </Button>
            )}
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

function Poster({ path, className }: { path: string | null | undefined; className?: string }) {
  return path ? (
    <img src={`${TMDB_IMAGES}w92${path}`} alt="" loading="lazy" className={`aspect-2/3 w-12 shrink-0 rounded object-cover ${className ?? ''}`} />
  ) : (
    <div className={`flex aspect-2/3 w-12 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground ${className ?? ''}`}>
      <Film className="size-4" />
    </div>
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
