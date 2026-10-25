import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Film, Folder } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Mono, Spinner } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { useEvent } from '@/lib/events'
import { tmdbImage } from '@/lib/media'

// What the Library page (pages/library.tsx; docs/media-server-plan.md §5.1–5.3)
// shares: the admin's folders (added with a server-side folder browser, edited,
// scanned: live through the `library.scan` event), what a file is, posters.

export type LibraryView = Schemas['LibraryView']
export type LibraryFolder = Schemas['LibraryFolder']
export type LibraryFile = Schemas['LibraryFile']
export type LibraryItem = Schemas['LibraryItem']
export type FolderKind = Schemas['LibraryFolderKind']
export type Audience = Schemas['LibraryAudience']
export type FileState = Schemas['LibraryFileState']
export type ScanEvent = Schemas['LibraryScanEvent']

/** What the path says (lib/library/parse.js) */
export interface Parsed {
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


export const kindLabel = (kind: FolderKind) => KINDS.find((k) => k.id === kind)?.label ?? kind
export const pad = (n: number | null | undefined) => String(n ?? 0).padStart(2, '0')
export const fileName = (relPath: string) => relPath.slice(relPath.lastIndexOf('/') + 1)

/** "Breaking Bad · S02E04 · Down" / "Heat (1995)" */
export function itemLabel(item: LibraryItem): string {
  if (item.kind === 'episode') {
    return [item.title ?? `TMDB ${item.showTmdbId}`, `S${pad(item.season)}E${pad(item.episode)}`, item.episodeTitle]
      .filter(Boolean)
      .join(' · ')
  }
  return (item.title ?? `TMDB ${item.tmdbId}`) + (item.year ? ` (${item.year})` : '')
}

export function quality(file: LibraryFile): string | null {
  const p = file.probe
  if (!p?.height) return (file.parse as Parsed | null)?.resolution ?? null
  const res = p.height >= 2000 ? '4K' : p.height >= 1000 ? '1080p' : p.height >= 700 ? '720p' : `${p.height}p`
  return [res, p.hdr ? 'HDR' : null, p.video].filter(Boolean).join(' · ')
}

export function useLibrary() {
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

export function useScan() {
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

// ── scans ─────────────────────────────────────────────────────────────────────

export function ScanStatus({ view }: { view: LibraryView }) {
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

export function folderStatus(folder: LibraryFolder): { text: string; tone: string } | null {
  if (folder.scanning) return { text: 'scanning', tone: 'text-primary' }
  if (folder.queued) return { text: 'waiting to scan', tone: 'text-muted-foreground' }
  if (folder.status === 'missing') return { text: 'unreachable: its files are kept 7 days', tone: 'text-warning' }
  if (folder.status.startsWith('error')) return { text: folder.status, tone: 'text-destructive' }
  return null
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

export function AddFolderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
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

export type Matcher = { id: string; name: string }

// The folder's information provider: Playpex's own matching (TMDB), or a plugin's library.match
const TMDB = 'tmdb'

export function EditFolderDialog({ folder, matchers, onClose }: { folder: LibraryFolder | null; matchers: Matcher[]; onClose: () => void }) {
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

export function MatchCell({ file }: { file: LibraryFile }) {
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

export function Poster({ path, className }: { path: string | null | undefined; className?: string }) {
  return path ? (
    <img src={tmdbImage(path, 'w92')!} alt="" loading="lazy" className={`aspect-2/3 w-12 shrink-0 rounded object-cover ${className ?? ''}`} />
  ) : (
    <div className={`flex aspect-2/3 w-12 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground ${className ?? ''}`}>
      <Film className="size-4" />
    </div>
  )
}

export function useFolderActions() {
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

