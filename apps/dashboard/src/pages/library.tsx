import { useQuery } from '@tanstack/react-query'
import { Clapperboard, Download, Folder, FolderPlus, HardDrive, LayoutGrid, MoreHorizontal, Pencil, RefreshCw, Trash2, Tv, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Confirm, Empty, Loading, QueryError } from '@/components/common'
import { CleanUp, PlaceBrowser, type Place } from '@/components/library-browser'
import {
  AddFolderDialog,
  EditFolderDialog,
  folderStatus,
  kindLabel,
  ScanStatus,
  useFolderActions,
  useLibrary,
  useScan,
  type LibraryFolder,
} from '@/components/library-common'
import { FileSheet } from '@/components/library-file'
import { FileList } from '@/components/library-fix'
import { TitleSheet, TitlesIndex, useLibraryHome } from '@/components/library-titles'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, unwrap } from '@/lib/api'
import { ago, bytes } from '@/lib/format'
import { cn } from '@/lib/utils'

// The Library: everything the server holds, one page (Storage and the old
// Library together; docs/dashboard-plan.md §6, docs/media-server-plan.md §5).
// The rail: Titles (the index: every movie and show as posters), To fix (files
// not matched, missing, ignored), then the places (the download folder and the
// admin's folders: their files and folders with what each is, the folder's own
// settings, scans, the disk). The URL keeps where you are: ?view=titles|fix,
// ?place=&path=&q= (a place; `downloads` = the download folder), ?file= (a
// file's sheet), ?title=movie:<id> (a title's sheet).

const PLACE_ICON: Record<Place['kind'], typeof Folder> = {
  downloads: Download,
  movies: Clapperboard,
  shows: Tv,
  mixed: Folder,
  other: Folder,
}

export function LibraryPage() {
  const library = useLibrary()
  const home = useLibraryHome()
  const scan = useScan()
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<LibraryFolder | null>(null)
  const places = useQuery({
    queryKey: ['storage-places'],
    queryFn: () => unwrap(api.GET('/admin/storage/places')),
    // sizes arrive once a place is measured
    refetchInterval: (q) => (q.state.data?.places.some((p) => p.measuring) ? 2000 : 30_000),
  })

  if (library.isPending || places.isPending) return <Loading />
  if (library.error) return <QueryError error={library.error} />
  if (places.error) return <QueryError error={places.error} />

  const { folders, scan: status } = library.data
  const placeList = places.data.places
  const asked = params.get('place')
  const place = asked ? (placeList.find((p) => p.id === asked) ?? (asked === 'downloads' ? placeList.find((p) => p.kind === 'downloads') : null) ?? null) : null
  const view = place ? 'place' : params.get('view') === 'fix' ? 'fix' : 'titles'
  const folderOf = (p: Place) => (p.id.startsWith('folder:') ? folders.find((f) => f.id === p.id.slice(7)) : undefined)

  const totals = folders.reduce(
    (t, f) => ({ ok: t.ok + f.counts.ok, unmatched: t.unmatched + f.counts.unmatched, missing: t.missing + f.counts.missing, ignored: t.ignored + f.counts.ignored }),
    { ok: 0, unmatched: 0, missing: 0, ignored: 0 },
  )
  const titles = (home.data?.movies.length ?? 0) + (home.data?.shows.length ?? 0)
  const held = placeList.reduce((sum, p) => sum + (p.bytes ?? 0), 0)
  const busy = !!status.current || status.queued.length > 0

  const set = (next: Record<string, string | null>, keep: string[] = []) =>
    setParams((prev) => {
      const out = new URLSearchParams()
      for (const k of keep) {
        const v = prev.get(k)
        if (v !== null) out.set(k, v)
      }
      for (const [k, v] of Object.entries(next)) if (v) out.set(k, v)
      return out
    })
  const go = (to: { view?: 'titles' | 'fix'; place?: string; path?: string; q?: string | null }) =>
    set(to.place ? { place: to.place, path: to.path ?? null, q: to.q ?? null } : { view: to.view === 'fix' ? 'fix' : null })
  // the sheets open over whatever is shown
  const keepView = ['view', 'place', 'path', 'q']
  const openFile = (id: string) => set({ file: id, title: params.get('title') }, keepView)
  const openTitle = (key: string) => set({ title: key }, keepView)

  return (
    <>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="mr-auto min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground tabular-nums">
            {titles} {titles === 1 ? 'title' : 'titles'} and {totals.ok + totals.unmatched} files in {placeList.length} {placeList.length === 1 ? 'place' : 'places'}
            {held ? `, ${bytes(held)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={scan.isPending || busy} onClick={() => scan.mutate({})}>
            <RefreshCw className={busy ? 'animate-spin' : undefined} /> Scan all
          </Button>
          <CleanUp />
          <Button onClick={() => setAdding(true)}>
            <FolderPlus /> Add folder
          </Button>
        </div>
      </div>

      <ScanStatus view={library.data} />

      <div className="grid gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
        {/* the rail on desktop, a select on phones */}
        <nav aria-label="Library" className="hidden flex-col gap-0.5 md:flex">
          <RailItem icon={LayoutGrid} label="Titles" count={titles} active={view === 'titles'} onClick={() => go({ view: 'titles' })} />
          <RailItem
            icon={Wand2}
            label="To fix"
            count={totals.unmatched + totals.missing}
            tone={totals.unmatched + totals.missing ? 'warn' : undefined}
            active={view === 'fix'}
            onClick={() => go({ view: 'fix' })}
          />
          <p className="px-2.5 pt-5 pb-1 text-xs font-medium text-muted-foreground">Places</p>
          {placeList.map((p) => (
            <PlaceItem
              key={p.id}
              place={p}
              folder={folderOf(p)}
              active={place?.id === p.id}
              onClick={() => go({ place: p.id })}
              onScan={(force) => {
                const f = folderOf(p)
                if (f) scan.mutate({ folderId: f.id, force })
              }}
              onEdit={() => {
                const f = folderOf(p)
                if (f) setEditing(f)
              }}
            />
          ))}
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <FolderPlus className="size-4" /> Add a folder
          </button>
        </nav>
        <div className="md:hidden">
          <Select
            value={place ? `place:${place.id}` : view}
            onValueChange={(v) => (v.startsWith('place:') ? go({ place: v.slice(6) }) : go({ view: v as 'titles' | 'fix' }))}
          >
            <SelectTrigger className="w-full" aria-label="Show">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="titles">Titles ({titles})</SelectItem>
              <SelectItem value="fix">To fix ({totals.unmatched + totals.missing})</SelectItem>
              <SelectGroup>
                <SelectLabel>Places</SelectLabel>
                {placeList.map((p) => (
                  <SelectItem key={p.id} value={`place:${p.id}`}>
                    {p.name} {p.bytes !== null ? `(${bytes(p.bytes)})` : ''} {p.status === 'offline' ? 'offline' : ''}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0">
          {view === 'titles' ? (
            <TitlesIndex onOpen={openTitle} onPlace={(id) => go({ place: id })} />
          ) : view === 'fix' ? (
            folders.length ? (
              <FileList folders={folders} totals={totals} onOpen={openFile} onRetry={() => scan.mutate({ force: true })} retrying={scan.isPending || busy} />
            ) : (
              <NoFolders onAdd={() => setAdding(true)} />
            )
          ) : place!.status === 'offline' ? (
            <Empty icon={<HardDrive />} title={`${place!.name} is offline`}>
              <span className="font-mono text-xs break-all">{place!.root}</span> isn’t there: a drive unplugged or a share not mounted. Its files stay in the
              library while it’s away.
            </Empty>
          ) : (
            <PlaceBrowser
              key={place!.id}
              place={place!}
              path={params.get('path') ?? ''}
              q={params.get('q') ?? ''}
              onGo={(to, q) => go({ place: place!.id, path: to, q })}
              onOpenFile={openFile}
              header={folderOf(place!) && <FolderFacts folder={folderOf(place!)!} onEdit={() => setEditing(folderOf(place!)!)} onScan={(force) => scan.mutate({ folderId: folderOf(place!)!.id, force })} />}
            />
          )}
        </div>
      </div>

      <AddFolderDialog open={adding} onOpenChange={setAdding} />
      <EditFolderDialog folder={editing} matchers={library.data.matchers} onClose={() => setEditing(null)} />
      <TitleSheet titleId={params.get('title')} onClose={() => set({}, keepView)} onOpenFile={openFile} />
      <FileSheet id={params.get('file')} folders={folders} onClose={() => set({ title: params.get('title') }, keepView)} />
    </>
  )
}

function NoFolders({ onAdd }: { onAdd: () => void }) {
  return (
    <Empty icon={<Folder />} title="No folders yet">
      Add the folders that hold your movies and shows: the server scans them, matches the files to TMDB and streams them to your devices. Files are
      only read, never moved or deleted.
      <div className="mt-4">
        <Button onClick={onAdd}>
          <FolderPlus /> Add folder
        </Button>
      </div>
    </Empty>
  )
}

function RailItem({
  icon: Icon,
  label,
  count,
  tone,
  active,
  onClick,
}: {
  icon: typeof Folder
  label: string
  count: number
  tone?: 'warn'
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted',
        active && 'bg-muted shadow-[inset_2px_0_0_var(--primary)]',
      )}
    >
      <Icon className={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')} />
      <span className={cn('min-w-0 flex-1 truncate', active ? 'font-medium' : 'text-muted-foreground group-hover:text-foreground')}>{label}</span>
      <span className={cn('text-xs tabular-nums', tone === 'warn' ? 'text-warning' : 'text-muted-foreground')}>{count}</span>
    </button>
  )
}

function PlaceItem({
  place,
  folder,
  active,
  onClick,
  onScan,
  onEdit,
}: {
  place: Place
  folder: LibraryFolder | undefined
  active: boolean
  onClick: () => void
  onScan: (force: boolean) => void
  onEdit: () => void
}) {
  const Icon = PLACE_ICON[place.kind]
  const actions = useFolderActions()
  const used = place.disk ? 1 - place.disk.free / place.disk.total : null
  const state = folder ? folderStatus(folder) : null
  return (
    <div
      className={cn(
        'group relative flex flex-col gap-1.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted',
        active && 'bg-muted shadow-[inset_2px_0_0_var(--primary)]',
      )}
    >
      <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className="absolute inset-0 rounded-lg" aria-label={place.name} />
      <span className="pointer-events-none flex items-center gap-2 text-sm">
        <Icon className={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')} />
        <span className={cn('min-w-0 flex-1 truncate', active ? 'font-medium' : 'text-muted-foreground group-hover:text-foreground')} title={place.root}>
          {place.name}
        </span>
        <span className={cn('text-xs text-muted-foreground tabular-nums', folder && 'group-hover:invisible group-focus-within:invisible')}>
          {place.status === 'offline' ? 'offline' : place.measuring ? '…' : bytes(place.bytes)}
        </span>
      </span>
      {folder && (
        <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-aria-expanded:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={`${place.name}: folder actions`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right">
              <DropdownMenuItem disabled={folder.scanning || folder.queued} onSelect={() => onScan(false)}>
                <RefreshCw /> Scan for new files
              </DropdownMenuItem>
              <DropdownMenuItem disabled={folder.scanning || folder.queued} onSelect={() => onScan(true)}>
                <Wand2 /> Scan and match unmatched files again
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil /> Edit…
              </DropdownMenuItem>
              {!folder.builtin && (
                <>
                  <DropdownMenuSeparator />
                  <Confirm
                    trigger={
                      <DropdownMenuItem variant="destructive" onSelect={(e) => e.preventDefault()}>
                        <Trash2 /> Remove from the library…
                      </DropdownMenuItem>
                    }
                    title="Remove this folder from the library?"
                    description={<>{folder.path}: its files leave the library and their matches are forgotten. Nothing is deleted from the disk.</>}
                    action="Remove"
                    onConfirm={() => actions.remove.mutate(folder.id)}
                  />
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {state ? (
        <span className={cn('pointer-events-none truncate pl-6 text-xs', state.tone)}>{state.text}</span>
      ) : used !== null && place.status === 'online' ? (
        <span className="pointer-events-none flex items-center gap-2 pl-6" title={`${bytes(place.disk!.free)} free of ${bytes(place.disk!.total)}`}>
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-(--strip-track)">
            <span className={cn('block h-full rounded-full', used > 0.9 ? 'bg-destructive' : 'bg-muted-foreground/50')} style={{ width: `${used * 100}%` }} />
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">{bytes(place.disk!.free)} free</span>
        </span>
      ) : null}
    </div>
  )
}

// A library folder's own line over its files: what it holds, who sees it, its scans
function FolderFacts({ folder, onEdit, onScan }: { folder: LibraryFolder; onEdit: () => void; onScan: (force: boolean) => void }) {
  const state = folderStatus(folder)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/30 px-3 py-2 text-xs">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-muted-foreground">
        <Badge variant="outline">{folder.builtin ? 'Downloads' : kindLabel(folder.kind)}</Badge>
        {folder.audience === 'adults' && <Badge variant="outline">Adults only</Badge>}
        {folder.matcher && <Badge variant="outline">Recognised by {folder.matcher}</Badge>}
        {folder.dlna && folder.audience === 'everyone' && (
          <Badge variant="outline" title="TVs and players on the network browse it (when DLNA is on in Settings)">
            DLNA
          </Badge>
        )}
        <span className="tabular-nums">
          {folder.counts.ok} matched
          {folder.counts.unmatched > 0 && <span className="text-warning">, {folder.counts.unmatched} unmatched</span>}
          {folder.counts.missing > 0 && <span className="text-destructive">, {folder.counts.missing} missing</span>}
          {folder.counts.ignored > 0 && `, ${folder.counts.ignored} ignored`}
          {`. Scanned ${folder.lastScanAt ? ago(folder.lastScanAt) : 'never'}`}
        </span>
        {state && <span className={state.tone}>({state.text})</span>}
      </div>
      <div className="flex gap-1">
        <Button variant="ghost" size="xs" disabled={folder.scanning || folder.queued} onClick={() => onScan(false)}>
          <RefreshCw className={folder.scanning ? 'animate-spin' : undefined} /> Scan
        </Button>
        <Button variant="ghost" size="xs" onClick={onEdit}>
          <Pencil /> Edit
        </Button>
      </div>
    </div>
  )
}
