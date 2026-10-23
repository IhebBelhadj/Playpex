import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Download as DownloadIcon, FileVideo, Pause, Play, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Empty, Loading, Mono, PageHeader, QueryError, Spinner } from '@/components/common'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage, unwrap, type Schemas } from '@/lib/api'
import { useEvent } from '@/lib/events'
import { ago, bytes, clock, dateTime, speed } from '@/lib/format'

// Every torrent the server keeps (docs/media-server-plan.md §4.5): what runs,
// what waits, what is done; add, start, pause, choose files, remove. Live
// through the events socket (download.updated patches the list in place).

type Download = Schemas['Download']
type State = Download['state']

const STATE: Record<State, { label: string; tone: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  downloading: { label: 'Downloading', tone: 'default' },
  seeding: { label: 'Seeding', tone: 'secondary' },
  checking: { label: 'Checking', tone: 'secondary' },
  queued: { label: 'Queued', tone: 'outline' },
  paused: { label: 'Paused', tone: 'outline' },
  completed: { label: 'Completed', tone: 'secondary' },
  error: { label: 'Error', tone: 'destructive' },
}

const FILTERS: { id: string; label: string; states: State[] | null }[] = [
  { id: 'all', label: 'All', states: null },
  { id: 'active', label: 'Active', states: ['downloading', 'seeding', 'checking'] },
  { id: 'queued', label: 'Queued', states: ['queued'] },
  { id: 'paused', label: 'Paused', states: ['paused', 'error'] },
  { id: 'completed', label: 'Completed', states: ['completed'] },
]

const RUNNING: State[] = ['downloading', 'seeding', 'checking']

function titleOf(d: Download): string | null {
  const t = d.title
  if (!t) return null
  const code = t.season ? ` · S${String(t.season).padStart(2, '0')}E${String(t.episode ?? 0).padStart(2, '0')}` : ''
  return (t.title ?? `TMDB ${t.mediaType} ${t.tmdbId}`) + (t.title?.includes(' · ') ? '' : code)
}

function useDownloads() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['downloads'],
    queryFn: () => unwrap(api.GET('/downloads')),
    refetchInterval: 30_000,
  })
  // progress every 2 s per torrent: patch the cached list instead of refetching
  useEvent<Download>('download.updated', (e) => {
    client.setQueryData<Download[]>(['downloads'], (list) =>
      list?.some((d) => d.infoHash === e.data.infoHash) ? list.map((d) => (d.infoHash === e.data.infoHash ? e.data : d)) : list,
    )
  })
  return query
}

function useActions() {
  const client = useQueryClient()
  const done = (message: string) => () => {
    toast.success(message)
    client.invalidateQueries({ queryKey: ['downloads'] })
    client.invalidateQueries({ queryKey: ['download'] })
  }
  const fail = (err: unknown) => toast.error(errorMessage(err))
  const path = (infoHash: string) => ({ params: { path: { infoHash } } })
  return {
    start: useMutation({ mutationFn: (h: string) => unwrap(api.POST('/downloads/{infoHash}/start', path(h))), onSuccess: done('Started'), onError: fail }),
    pause: useMutation({ mutationFn: (h: string) => unwrap(api.POST('/downloads/{infoHash}/pause', path(h))), onSuccess: done('Paused'), onError: fail }),
    remove: useMutation({
      mutationFn: ({ hash, data }: { hash: string; data: 'keep' | 'delete' }) =>
        unwrap(api.DELETE('/downloads/{infoHash}', { params: { path: { infoHash: hash }, query: { data } } })),
      onSuccess: (_, { data }) => {
        done(data === 'delete' ? 'Removed with its files' : 'Removed, files kept')()
        client.invalidateQueries({ queryKey: ['storage'] })
      },
      onError: fail,
    }),
  }
}

export function DownloadsPage() {
  const downloads = useDownloads()
  const actions = useActions()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState('all')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Download | null>(null)
  const open = params.get('hash')

  const list = useMemo(() => downloads.data ?? [], [downloads.data])
  const shown = useMemo(() => {
    const states = FILTERS.find((f) => f.id === filter)?.states
    return states ? list.filter((d) => states.includes(d.state)) : list
  }, [list, filter])
  const totals = list.reduce((s, d) => ({ down: s.down + d.downloadSpeed, up: s.up + d.uploadSpeed }), { down: 0, up: 0 })

  if (downloads.isPending) return <Loading />
  if (downloads.error) return <QueryError error={downloads.error} />

  return (
    <>
      <PageHeader
        title="Downloads"
        description={
          <span className="flex flex-wrap items-center gap-3 font-mono text-xs">
            <span className="flex items-center gap-1">
              <ArrowDown className="size-3" /> {speed(totals.down)}
            </span>
            <span className="flex items-center gap-1">
              <ArrowUp className="size-3" /> {speed(totals.up)}
            </span>
            <span>{list.filter((d) => RUNNING.includes(d.state)).length} running</span>
          </span>
        }
        actions={
          <div className="flex gap-2">
            <PauseAllButton />
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add
            </Button>
          </div>
        }
      />
      {/* scrolls by itself on a phone, not the page */}
      <Tabs value={filter} onValueChange={setFilter} className="max-w-full overflow-x-auto [scrollbar-width:none]">
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f.id} value={f.id}>
              {f.label}
              <span className="ml-1 text-muted-foreground tabular-nums">
                {f.states ? list.filter((d) => f.states!.includes(d.state)).length : list.length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {shown.length === 0 ? (
        <Empty icon={<DownloadIcon />} title={list.length ? 'Nothing here' : 'No downloads yet'}>
          {list.length
            ? 'No download is in this state.'
            : 'Torrents played on a device show up here, kept after the player leaves. Add one to download it without playing.'}
        </Empty>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-48">Progress</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Speed</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Peers</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Ratio</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Size</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((d) => (
                  <DownloadRow
                    key={d.infoHash}
                    d={d}
                    onOpen={() => setParams({ hash: d.infoHash })}
                    onStart={() => actions.start.mutate(d.infoHash)}
                    onPause={() => actions.pause.mutate(d.infoHash)}
                    onRemove={() => setRemoving(d)}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <AddDialog open={adding} onOpenChange={setAdding} />
      <RemoveDialog
        download={removing}
        onClose={() => setRemoving(null)}
        onRemove={(data) => {
          if (removing) actions.remove.mutate({ hash: removing.infoHash, data })
          if (removing?.infoHash === open) setParams({})
          setRemoving(null)
        }}
      />
      <DetailSheet
        hash={open}
        onClose={() => setParams({})}
        onRemove={(d) => setRemoving(d)}
      />
    </>
  )
}

function StateBadge({ d }: { d: Download }) {
  const s = STATE[d.state]
  return (
    <Badge variant={s.tone} title={d.error ?? undefined}>
      {s.label}
      {d.state === 'checking' && d.checking !== null && ` ${Math.round(d.checking * 100)} %`}
    </Badge>
  )
}

function DownloadRow({
  d,
  onOpen,
  onStart,
  onPause,
  onRemove,
}: {
  d: Download
  onOpen: () => void
  onStart: () => void
  onPause: () => void
  onRemove: () => void
}) {
  const running = RUNNING.includes(d.state) || d.state === 'queued'
  const pct = d.progress === null ? null : Math.round(d.progress * 100)
  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell className="w-full max-w-0">
        <div className="truncate font-medium" title={d.name ?? d.infoHash}>
          {d.name ?? <Mono className="text-xs">{d.infoHash}</Mono>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StateBadge d={d} />
          {titleOf(d) && <span className="truncate">{titleOf(d)}</span>}
          <span>{d.intent === 'stream' ? 'played' : 'download'}</span>
          {d.addedBy && <span className="hidden truncate sm:inline">by {d.addedBy}</span>}
        </div>
      </TableCell>
      <TableCell>
        <div className="space-y-1">
          <Progress value={pct ?? 0} />
          <div className="flex justify-between font-mono text-xs text-muted-foreground tabular-nums">
            <span>{pct === null ? 'waiting for metadata' : `${pct} %`}</span>
            {d.eta !== null && d.state === 'downloading' && <span>{clock(d.eta)} left</span>}
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden text-right font-mono text-xs whitespace-nowrap tabular-nums md:table-cell">
        <div>↓ {speed(d.downloadSpeed)}</div>
        <div className="text-muted-foreground">↑ {speed(d.uploadSpeed)}</div>
      </TableCell>
      <TableCell className="hidden text-right font-mono text-xs tabular-nums lg:table-cell">
        {d.peers}
        {d.seeds > 0 && <span className="text-muted-foreground"> ({d.seeds})</span>}
      </TableCell>
      <TableCell className="hidden text-right font-mono text-xs tabular-nums lg:table-cell">{d.ratio === null ? '—' : d.ratio.toFixed(2)}</TableCell>
      <TableCell className="hidden text-right font-mono text-xs whitespace-nowrap tabular-nums sm:table-cell">{bytes(d.sizeBytes)}</TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end gap-1">
          {running ? (
            <Button variant="ghost" size="icon-sm" aria-label="Pause" title="Pause" onClick={onPause}>
              <Pause />
            </Button>
          ) : (
            <Button variant="ghost" size="icon-sm" aria-label="Start" title="Download to the end" onClick={onStart} disabled={d.state === 'completed' && d.progress === 1}>
              <Play />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Remove" title="Remove" onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

// "Pause all downloads" (downloads.paused, the tray's too): downloads wait, streams still play
function PauseAllButton() {
  const client = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => unwrap(api.GET('/admin/settings')) })
  const paused = settings.data?.settings.downloads.paused ?? false
  const toggle = useMutation({
    mutationFn: (value: boolean) => unwrap(api.PUT('/admin/settings', { body: { downloads: { paused: value } } })),
    onSuccess: (_, value) => {
      toast.success(value ? 'Downloads paused (streams still play)' : 'Downloads resumed')
      client.invalidateQueries({ queryKey: ['settings'] })
      client.invalidateQueries({ queryKey: ['downloads'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (!settings.data) return null
  return (
    <Button variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate(!paused)}>
      {paused ? <Play /> : <Pause />} {paused ? 'Resume all' : 'Pause all'}
    </Button>
  )
}

function AddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient()
  const [link, setLink] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const add = useMutation({
    mutationFn: () => {
      if (file) {
        const form = new FormData()
        form.append('file', file)
        return unwrap(
          api.POST('/downloads', {
            body: form as never,
            bodySerializer: (b: unknown) => b as FormData,
          }),
        )
      }
      return unwrap(api.POST('/downloads', { body: { link: link.trim() } }))
    },
    onSuccess: (d) => {
      toast.success(`${d.name ?? 'Torrent'} added (${STATE[d.state].label.toLowerCase()})`)
      client.invalidateQueries({ queryKey: ['downloads'] })
      setLink('')
      setFile(null)
      onOpenChange(false)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (link.trim() || file) add.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add a download</DialogTitle>
            <DialogDescription>It downloads to the end without a player, then seeds as Settings › Downloads says.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="add-link">Magnet link, info hash or .torrent URL</Label>
            <Input id="add-link" value={link} disabled={!!file} placeholder="magnet:?xt=urn:btih:…" onChange={(e) => setLink(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="add-file">Or a .torrent file</Label>
            <Input id="add-file" type="file" accept=".torrent,application/x-bittorrent" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={add.isPending || (!link.trim() && !file)}>
              {add.isPending && <Spinner />} Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RemoveDialog({
  download,
  onClose,
  onRemove,
}: {
  download: Download | null
  onClose: () => void
  onRemove: (data: 'keep' | 'delete') => void
}) {
  return (
    <AlertDialog open={!!download} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this download?</AlertDialogTitle>
          <AlertDialogDescription>
            {download?.name ?? download?.infoHash}: the server forgets it. Its files stay in the download directory, or are deleted
            with it. Devices playing it are stopped.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="outline" onClick={() => onRemove('keep')}>
            Keep files
          </Button>
          <Button variant="destructive" onClick={() => onRemove('delete')}>
            Delete files
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function DetailSheet({ hash, onClose, onRemove }: { hash: string | null; onClose: () => void; onRemove: (d: Download) => void }) {
  const client = useQueryClient()
  const detail = useQuery({
    queryKey: ['download', hash],
    queryFn: () => unwrap(api.GET('/downloads/{infoHash}', { params: { path: { infoHash: hash! } } })),
    enabled: !!hash,
    refetchInterval: 3000,
  })
  const [chosen, setChosen] = useState<string[] | null>(null)
  const d = detail.data
  const files = useMemo(() => d?.files ?? [], [d])
  const selected = chosen ?? files.filter((f) => f.selected).map((f) => f.path)
  const changed = chosen !== null && JSON.stringify([...chosen].sort()) !== JSON.stringify(files.filter((f) => f.selected).map((f) => f.path).sort())
  const refresh = () => {
    client.invalidateQueries({ queryKey: ['download', hash] })
    client.invalidateQueries({ queryKey: ['downloads'] })
  }
  const select = useMutation({
    mutationFn: (paths: string[]) =>
      unwrap(
        api.PUT('/downloads/{infoHash}/files', {
          params: { path: { infoHash: hash! } },
          body: { files: paths.length === files.length ? null : paths },
        }),
      ),
    onSuccess: () => {
      toast.success('Files chosen')
      setChosen(null)
      refresh()
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const rule = useMutation({
    mutationFn: (value: boolean) =>
      unwrap(api.PATCH('/downloads/{infoHash}', { params: { path: { infoHash: hash! } }, body: { removeWhenWatched: value } })),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  })

  return (
    <Sheet
      open={!!hash}
      onOpenChange={(o) => {
        if (!o) {
          setChosen(null)
          onClose()
        }
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="pr-6 break-all">{d?.name ?? hash}</SheetTitle>
          <SheetDescription>{d && titleOf(d)}</SheetDescription>
        </SheetHeader>
        {detail.isPending && hash ? (
          <Loading />
        ) : detail.error ? (
          <QueryError error={detail.error} title="Could not load this download" />
        ) : d ? (
          <div className="space-y-6 px-4 pb-6">
            <div className="flex flex-wrap items-center gap-2">
              <StateBadge d={d} />
              <span className="text-sm text-muted-foreground">{d.intent === 'stream' ? 'Played on a device' : 'Downloaded to the end'}</span>
            </div>
            {d.error && <p className="text-sm text-destructive">{d.error}</p>}
            <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Progress</dt>
              <dd className="font-mono tabular-nums">
                {bytes(d.doneBytes)} / {bytes(d.sizeBytes)} {d.progress !== null && `(${Math.round(d.progress * 100)} %)`}
              </dd>
              <dt className="text-muted-foreground">Uploaded</dt>
              <dd className="font-mono tabular-nums">
                {bytes(d.uploadedBytes)} {d.ratio !== null && `· ratio ${d.ratio.toFixed(2)}`}
              </dd>
              <dt className="text-muted-foreground">Added</dt>
              <dd>
                {dateTime(d.addedAt)} {d.addedBy && <span className="text-muted-foreground">by {d.addedBy}</span>}
              </dd>
              {d.completedAt && (
                <>
                  <dt className="text-muted-foreground">Completed</dt>
                  <dd>{dateTime(d.completedAt)}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Last active</dt>
              <dd>{d.lastActiveAt ? ago(d.lastActiveAt) : 'never'}</dd>
              <dt className="text-muted-foreground">Info hash</dt>
              <dd className="font-mono text-xs break-all">{d.infoHash}</dd>
            </dl>
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div>
                <Label htmlFor="remove-watched">Remove when watched</Label>
                <p className="mt-1 text-xs text-muted-foreground">Deleted with its files once a player reached the end (90 %).</p>
              </div>
              <Switch id="remove-watched" checked={d.removeWhenWatched} disabled={rule.isPending} onCheckedChange={(v) => rule.mutate(v)} />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Files</h3>
                {changed && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setChosen(null)}>
                      Undo
                    </Button>
                    <Button size="sm" disabled={select.isPending || selected.length === 0} onClick={() => select.mutate(selected)}>
                      Save
                    </Button>
                  </div>
                )}
              </div>
              {d.files === null ? (
                <p className="text-sm text-muted-foreground">Waiting for the torrent's metadata.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {files.map((f) => {
                    const on = selected.includes(f.path)
                    const pct = f.doneBytes === null ? null : Math.floor((f.doneBytes / Math.max(f.size, 1)) * 100)
                    // inside the torrent's folder: the part that differs
                    const shown = d.name && f.path.startsWith(d.name + '/') ? f.path.slice(d.name.length + 1) : f.path
                    return (
                      <li key={f.path} className="flex items-center gap-3 p-2">
                        <Checkbox
                          checked={on}
                          aria-label={`Download ${f.name}`}
                          onCheckedChange={(v) => setChosen(v ? [...selected, f.path] : selected.filter((p) => p !== f.path))}
                        />
                        <FileVideo className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm" title={f.path}>
                            {shown}
                          </div>
                          {pct !== null && <Progress value={pct} className="mt-1 h-1" />}
                        </div>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                          {pct !== null && `${pct} % · `}
                          {bytes(f.size)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <Button variant="outline" className="text-destructive" onClick={() => onRemove(d)}>
              <Trash2 /> Remove…
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
