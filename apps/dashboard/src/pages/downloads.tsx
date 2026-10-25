import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Copy,
  Download as DownloadIcon,
  FileDown,
  FileUp,
  FolderOpen,
  Gauge,
  HardDrive,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { AddDownloadDialog } from '@/components/add-download'
import { RailGroup, RailItem, useIsDesktop } from '@/components/rail'
import { DirectList } from '@/components/direct-list'
import { useDirectDownloads } from '@/lib/direct'
import { RulesDialog } from '@/components/download-rules'
import { Empty, Loading, QueryError, Spinner } from '@/components/common'
import { DataTable, type RowAction } from '@/components/data-table'
import { DownloadPane, PANE_TABS, type PaneTab } from '@/components/download-pane'
import { useOverview } from '@/components/layout'
import { usePlayer } from '@/lib/player'
import { SwarmStrip, toneOf } from '@/components/swarm-strip'
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage, unwrap } from '@/lib/api'
import {
  canPause,
  canStart,
  KINDS,
  kindOf,
  magnetOf,
  RUNNING,
  stateText,
  swarmText,
  titleOf,
  torrentFileUrl,
  useDeviceNames,
  useDownloadActions,
  useDownloads,
  useEngineCaps,
  videoToPlay,
  type Download,
  type DownloadState,
} from '@/lib/downloads'
import { ago, bytes, clock, dateTime, speed } from '@/lib/format'
import { cn } from '@/lib/utils'

// Downloads as a torrent client (docs/dashboard-plan.md §4, step 2): a filter
// rail, the list (DataTable: sortable, columns to choose, multi-select, a row
// menu, the keyboard), the selected download's detail under it (a sheet on a
// phone), a status bar with the totals, the speed limits, the disk and "Pause
// all". The URL keeps the filter (?filter=), the open download (?hash=) and
// its tab (?tab=). Drop a .torrent anywhere on the page to add it.

const STATES: { id: string; label: string; states: DownloadState[] }[] = [
  { id: 'downloading', label: 'Downloading', states: ['downloading', 'checking'] },
  { id: 'seeding', label: 'Seeding', states: ['seeding'] },
  { id: 'completed', label: 'Completed', states: ['completed'] },
  { id: 'paused', label: 'Paused', states: ['paused'] },
  { id: 'queued', label: 'Queued', states: ['queued'] },
  { id: 'error', label: 'Errors', states: ['error'] },
]

function matches(d: Download, filter: string): boolean {
  if (filter === 'all') return true
  if (filter.startsWith('kind:')) return kindOf(d) === filter.slice(5)
  if (filter.startsWith('label:')) return d.label === filter.slice(6)
  return STATES.find((s) => s.id === filter)?.states.includes(d.state) ?? true
}

const PANE_KEY = 'playpex.downloads.pane'

function usePaneHeight() {
  const [height, setHeight] = useState(() => {
    try {
      return Number(localStorage.getItem(PANE_KEY)) || 300
    } catch {
      return 300
    }
  })
  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const start = height
    let last = start
    const move = (ev: PointerEvent) => {
      last = Math.max(160, Math.min(window.innerHeight * 0.7, start + startY - ev.clientY))
      setHeight(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(PANE_KEY, String(Math.round(last)))
      } catch {
        // a per-viewer convenience: fine without it
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return { height, drag }
}

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error(`Couldn't copy the ${what.toLowerCase()}`),
  )
}

export function DownloadsPage() {
  const downloads = useDownloads()
  const actions = useDownloadActions()
  const deviceName = useDeviceNames()
  const navigate = useNavigate()
  const desktop = useIsDesktop()
  const directs = useDirectDownloads()
  const directCount = directs.data?.length ?? 0
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [addKey, setAddKey] = useState(0)
  const [dropped, setDropped] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [removing, setRemoving] = useState<string[] | null>(null)
  const [labelling, setLabelling] = useState<string[] | null>(null)
  const [ruling, setRuling] = useState<string[] | null>(null)
  const pane = usePaneHeight()
  const player = usePlayer()
  const caps = useEngineCaps()

  // its video, from the download's file list (the largest selected one)
  const playDownload = (d: Download) => {
    unwrap(api.GET('/downloads/{infoHash}', { params: { path: { infoHash: d.infoHash } } }))
      .then((detail) => {
        const file = videoToPlay(detail.files)
        if (!file) {
          toast.error(detail.files ? 'It has no video to play' : 'Its files aren’t known yet: it needs its metadata first')
          return
        }
        player.play({ ref: file.ref, title: file.name, detail: d.name ?? undefined, place: 'downloads', dir: file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '' })
      })
      .catch((err) => toast.error(errorMessage(err)))
  }

  const filter = params.get('filter') ?? 'all'
  const open = params.get('hash')
  const tab = (PANE_TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as PaneTab) : 'general'
  const setParam = useCallback(
    (changes: Record<string, string | null>) =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p)
          for (const [k, v] of Object.entries(changes)) {
            if (v === null) next.delete(k)
            else next.set(k, v)
          }
          return next
        },
        { replace: true },
      ),
    [setParams],
  )

  const list = useMemo(() => downloads.data ?? [], [downloads.data])
  const byHash = useMemo(() => new Map(list.map((d) => [d.infoHash, d])), [list])
  const labels = useMemo(() => [...new Set(list.map((d) => d.label).filter((l): l is string => !!l))].sort(), [list])
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return list.filter(
      (d) =>
        matches(d, filter) &&
        words.every((w) => `${d.name ?? ''} ${titleOf(d) ?? ''} ${d.label ?? ''} ${d.infoHash}`.toLowerCase().includes(w)),
    )
  }, [list, filter, q])

  // the selection: only downloads that still exist and are shown
  const [picked, setSelection] = useState<string[]>([])
  const selection = useMemo(() => {
    const visible = new Set(shown.map((d) => d.infoHash))
    return picked.every((h) => visible.has(h)) ? picked : picked.filter((h) => visible.has(h))
  }, [picked, shown])

  const chosen = selection.map((h) => byHash.get(h)).filter((d): d is Download => !!d)
  const openPane = (hash: string | null) => setParam({ hash, tab: hash ? (params.get('tab') ?? null) : null })

  // Space: pause what runs, else start
  const toggleRun = (hashes: string[]) => {
    const ds = hashes.map((h) => byHash.get(h)).filter((d): d is Download => !!d)
    const running = ds.filter(canPause)
    if (running.length) actions.pause.mutate(running.map((d) => d.infoHash))
    else {
      const stopped = ds.filter(canStart)
      if (stopped.length) actions.start.mutate(stopped.map((d) => d.infoHash))
    }
  }

  const queueLength = list.filter((x) => x.state === 'queued').length

  const rowActions = (d: Download): RowAction[] => {
    const targets = selection.includes(d.infoHash) ? chosen : [d]
    const hashes = targets.map((t) => t.infoHash)
    const many = targets.length > 1 ? ` ${targets.length}` : ''
    const forced = targets.every((t) => t.forced)
    const running = targets.filter((t) => RUNNING.includes(t.state))
    const queue: RowAction[] =
      targets.length === 1 && d.state === 'queued' && d.queuePosition && !d.forced
        ? [
            'separator',
            { label: 'Move to the front', icon: <ArrowUpToLine />, disabled: d.queuePosition === 1, onSelect: () => actions.move.mutate({ hash: d.infoHash, position: 1 }) },
            { label: 'Move up', icon: <ArrowUp />, disabled: d.queuePosition === 1, onSelect: () => actions.move.mutate({ hash: d.infoHash, position: d.queuePosition! - 1 }) },
            { label: 'Move down', icon: <ArrowDown />, disabled: d.queuePosition >= queueLength, onSelect: () => actions.move.mutate({ hash: d.infoHash, position: d.queuePosition! + 1 }) },
            { label: 'Move to the back', icon: <ArrowDownToLine />, disabled: d.queuePosition >= queueLength, onSelect: () => actions.move.mutate({ hash: d.infoHash, position: queueLength }) },
          ]
        : []
    return [
      { label: 'Play', icon: <MonitorPlay />, shortcut: 'P', disabled: targets.length > 1 || d.name === null, onSelect: () => playDownload(d) },
      'separator',
      { label: `Start${many}`, icon: <Play />, shortcut: 'Space', disabled: !targets.some(canStart), onSelect: () => actions.start.mutate(targets.filter(canStart).map((t) => t.infoHash)) },
      { label: `Pause${many}`, icon: <Pause />, shortcut: 'Space', disabled: !targets.some(canPause), onSelect: () => actions.pause.mutate(targets.filter(canPause).map((t) => t.infoHash)) },
      forced
        ? { label: 'Stop forcing', icon: <Zap />, onSelect: () => actions.force.mutate({ hashes, on: false }) }
        : {
            label: `Force start${many}`,
            icon: <Zap />,
            disabled: targets.every((t) => t.state === 'completed' && t.progress === 1),
            onSelect: () => actions.force.mutate({ hashes: targets.filter((t) => !t.forced && !(t.state === 'completed' && t.progress === 1)).map((t) => t.infoHash), on: true }),
          },
      ...queue,
      'separator',
      { label: 'Seeding goal and speed limits…', icon: <Gauge />, onSelect: () => setRuling(hashes) },
      {
        label: 'Check the data again',
        icon: <RefreshCw />,
        disabled: !caps.can('recheck') || !running.length,
        onSelect: () => actions.recheck.mutate(running.map((t) => t.infoHash)),
      },
      {
        label: 'Announce again',
        icon: <Radio />,
        disabled: !caps.can('reannounce') || !running.length,
        onSelect: () => actions.reannounce.mutate(running.map((t) => t.infoHash)),
      },
      'separator',
      { label: 'Set label…', icon: <Tag />, onSelect: () => setLabelling(hashes) },
      { label: 'Copy magnet link', icon: <Copy />, disabled: targets.length > 1, onSelect: () => copy(magnetOf(d), 'Magnet link') },
      {
        label: 'Export .torrent',
        icon: <FileDown />,
        disabled: targets.length > 1 || d.name === null,
        onSelect: () => {
          const a = document.createElement('a')
          a.href = torrentFileUrl(d)
          a.download = ''
          a.click()
        },
      },
      { label: 'Show in the Library', icon: <FolderOpen />, onSelect: () => navigate('/library?place=downloads') },
      'separator',
      { label: `Remove${many}…`, icon: <Trash2 />, shortcut: 'Del', destructive: true, onSelect: () => setRemoving(hashes) },
    ]
  }

  const columns = useMemo<ColumnDef<Download, unknown>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (d) => (d.name ?? d.infoHash).toLowerCase(),
        header: 'Name',
        meta: { label: 'Name', fixed: true, className: 'w-full max-w-0 min-w-56' },
        cell: ({ row: { original: d } }) => (
          <div className="min-w-0">
            <div className="truncate font-medium" title={d.name ?? d.infoHash}>
              {d.name ?? <span className="font-mono text-xs text-muted-foreground">{d.infoHash}</span>}
            </div>
            {(titleOf(d) || d.label) && (
              <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                {titleOf(d) && <span className="truncate">{titleOf(d)}</span>}
                {d.label && (
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <Tag className="size-3" />
                    {d.label}
                  </span>
                )}
              </div>
            )}
          </div>
        ),
      },
      {
        id: 'size',
        accessorFn: (d) => d.sizeBytes ?? -1,
        header: 'Size',
        meta: { label: 'Size', numeric: true, from: '3xl' },
        cell: ({ row: { original: d } }) => bytes(d.sizeBytes),
      },
      {
        id: 'done',
        accessorFn: (d) => d.progress ?? -1,
        header: 'Done',
        meta: { label: 'Done', className: 'w-48' },
        cell: ({ row: { original: d } }) => (
          <div className="flex items-center gap-2.5">
            <SwarmStrip map={d.pieceMap} progress={d.progress} tone={toneOf(d)} className="min-w-20 flex-1" />
            <span className="w-11 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {d.progress === null ? '' : `${Math.floor(d.progress * 1000) / 10} %`}
            </span>
          </div>
        ),
      },
      {
        id: 'status',
        accessorFn: (d) => stateText(d),
        header: 'Status',
        meta: { label: 'Status', className: 'whitespace-nowrap' },
        cell: ({ row: { original: d } }) => (
          <span
            title={d.error ?? undefined}
            className={cn(
              d.state === 'error' && 'font-medium text-destructive',
              ['paused', 'queued', 'completed'].includes(d.state) && 'text-muted-foreground',
            )}
          >
            {stateText(d)}
          </span>
        ),
      },
      {
        id: 'down',
        accessorFn: (d) => d.downloadSpeed,
        header: 'Down',
        meta: { label: 'Download speed', numeric: true, from: '2xl' },
        cell: ({ row: { original: d } }) =>
          d.downloadSpeed ? <span className="text-down">{speed(d.downloadSpeed)}</span> : <span className="text-muted-foreground/60">—</span>,
      },
      {
        id: 'up',
        accessorFn: (d) => d.uploadSpeed,
        header: 'Up',
        meta: { label: 'Upload speed', numeric: true, from: '2xl' },
        cell: ({ row: { original: d } }) =>
          d.uploadSpeed ? <span className="text-up">{speed(d.uploadSpeed)}</span> : <span className="text-muted-foreground/60">—</span>,
      },
      {
        id: 'eta',
        accessorFn: (d) => (d.eta !== null && d.state === 'downloading' ? d.eta : Number.MAX_SAFE_INTEGER),
        header: 'Time left',
        meta: { label: 'Time left', numeric: true, from: '4xl' },
        cell: ({ row: { original: d } }) => (d.eta !== null && d.state === 'downloading' ? clock(d.eta) : <span className="text-muted-foreground/60">—</span>),
      },
      {
        id: 'seeds',
        accessorFn: (d) => d.seeds,
        header: 'Seeds',
        meta: { label: 'Seeds (connected, in the swarm)', numeric: true, from: '6xl' },
        cell: ({ row: { original: d } }) => (
          <span title={d.swarm ? `${d.swarm.seeds} in the swarm (trackers, ${ago(d.swarm.at)})` : undefined}>
            {swarmText(d.seeds, d.swarm?.seeds, RUNNING.includes(d.state))}
          </span>
        ),
      },
      {
        id: 'peers',
        accessorFn: (d) => d.peers,
        header: 'Peers',
        meta: { label: 'Peers (connected, in the swarm)', numeric: true, from: '5xl' },
        cell: ({ row: { original: d } }) => (
          <span title={d.swarm ? `${d.swarm.peers} leechers in the swarm (trackers, ${ago(d.swarm.at)})` : undefined}>
            {swarmText(d.peers, d.swarm?.peers, RUNNING.includes(d.state))}
          </span>
        ),
      },
      {
        id: 'ratio',
        accessorFn: (d) => d.ratio ?? -1,
        header: 'Ratio',
        meta: { label: 'Ratio', numeric: true, from: '4xl' },
        cell: ({ row: { original: d } }) => (d.ratio === null ? '—' : d.ratio.toFixed(2)),
      },
      {
        id: 'downloaded',
        accessorFn: (d) => d.doneBytes,
        header: 'Downloaded',
        meta: { label: 'Downloaded', numeric: true },
        cell: ({ row: { original: d } }) => bytes(d.doneBytes),
      },
      {
        id: 'uploaded',
        accessorFn: (d) => d.uploadedBytes,
        header: 'Uploaded',
        meta: { label: 'Uploaded', numeric: true },
        cell: ({ row: { original: d } }) => bytes(d.uploadedBytes),
      },
      {
        id: 'added',
        accessorFn: (d) => d.addedAt,
        header: 'Added',
        meta: { label: 'Added', numeric: true },
        cell: ({ row: { original: d } }) => <span title={dateTime(d.addedAt)}>{ago(d.addedAt)}</span>,
      },
      {
        id: 'completedAt',
        accessorFn: (d) => d.completedAt ?? '',
        header: 'Completed',
        meta: { label: 'Completed', numeric: true },
        cell: ({ row: { original: d } }) => (d.completedAt ? <span title={dateTime(d.completedAt)}>{ago(d.completedAt)}</span> : '—'),
      },
      {
        id: 'lastActive',
        accessorFn: (d) => d.lastActiveAt ?? '',
        header: 'Last active',
        meta: { label: 'Last active', numeric: true },
        cell: ({ row: { original: d } }) => (d.lastActiveAt ? ago(d.lastActiveAt) : '—'),
      },
      {
        id: 'label',
        accessorFn: (d) => d.label ?? '',
        header: 'Label',
        meta: { label: 'Label' },
        cell: ({ row: { original: d } }) => d.label ?? '',
      },
      {
        id: 'addedBy',
        accessorFn: (d) => deviceName(d.addedBy) ?? '',
        header: 'Added by',
        meta: { label: 'Added by', className: 'whitespace-nowrap first-letter:uppercase' },
        cell: ({ row: { original: d } }) => deviceName(d.addedBy) ?? '—',
      },
      {
        id: 'savePath',
        accessorFn: (d) => d.savePath,
        header: 'Saved in',
        meta: { label: 'Saved in', className: 'max-w-64' },
        cell: ({ row: { original: d } }) => (
          <span className="block truncate text-muted-foreground" title={d.savePath}>
            {d.savePath}
          </span>
        ),
      },
    ],
    [deviceName],
  )

  // a .torrent dropped anywhere on the page
  const dragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragging(true)
  }
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    if (!/\.torrent$/i.test(file.name)) {
      toast.error(`${file.name} isn't a .torrent file`)
      return
    }
    setDropped(file)
    setAddKey((k) => k + 1)
    setAdding(true)
  }

  // Escape closes the pane (when the list doesn't take it to clear a selection)
  useEffect(() => {
    if (!open || !desktop) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role=dialog], [role=menu]')) openPane(null)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  if (downloads.isPending) return <Loading />
  if (downloads.error) return <QueryError error={downloads.error} />

  const counts = (states: DownloadState[]) => list.filter((d) => states.includes(d.state)).length

  return (
    <div
      className="relative flex flex-col gap-4 md:h-[calc(100svh-4rem)]"
      onDragOver={dragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={drop}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold tracking-tight">Downloads</h1>
        <Button
          onClick={() => {
            setAddKey((k) => k + 1)
            setAdding(true)
          }}
        >
          <Plus /> Add torrent
        </Button>
        <Button variant="outline" asChild>
          <Link to="/search">
            <Search /> Search
          </Link>
        </Button>
        <div className="hidden items-center gap-1 border-l pl-2 md:flex">
          <Button
            variant="ghost"
            size="sm"
            disabled={!chosen.some(canStart)}
            onClick={() => actions.start.mutate(chosen.filter(canStart).map((d) => d.infoHash))}
          >
            <Play /> Start
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!chosen.some(canPause)}
            onClick={() => actions.pause.mutate(chosen.filter(canPause).map((d) => d.infoHash))}
          >
            <Pause /> Pause
          </Button>
          <Button variant="ghost" size="sm" className="hidden sm:inline-flex" disabled={!chosen.length} onClick={() => setLabelling(selection)}>
            <Tag /> Label
          </Button>
          <Button variant="ghost" size="sm" disabled={!chosen.length} onClick={() => setRemoving(selection)} className="hover:text-destructive">
            <Trash2 /> Remove
          </Button>
          {chosen.length > 1 && <span className="ml-1 text-sm text-muted-foreground tabular-nums">{chosen.length} selected</span>}
        </div>
        <div className="relative ml-auto w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a download" aria-label="Find a download" className="pl-8" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* the filter rail (a select on phones) */}
        <nav aria-label="Filter downloads" className="hidden w-44 shrink-0 flex-col gap-4 overflow-y-auto md:flex">
          <RailGroup>
            <RailItem label="All" count={list.length} active={filter === 'all'} onClick={() => setParam({ filter: null })} />
            {STATES.filter((s) => s.id !== 'error' || counts(s.states)).map((s) => (
              <RailItem
                key={s.id}
                label={s.label}
                count={counts(s.states)}
                active={filter === s.id}
                tone={s.id === 'error' ? 'fault' : undefined}
                onClick={() => setParam({ filter: s.id })}
              />
            ))}
          </RailGroup>
          <RailGroup title="What it is">
            {KINDS.map((k) => (
              <RailItem
                key={k.id}
                label={k.label}
                count={list.filter((d) => kindOf(d) === k.id).length}
                active={filter === `kind:${k.id}`}
                onClick={() => setParam({ filter: `kind:${k.id}` })}
              />
            ))}
          </RailGroup>
          {labels.length > 0 && (
            <RailGroup title="Labels">
              {labels.map((l) => (
                <RailItem
                  key={l}
                  label={l}
                  count={list.filter((d) => d.label === l).length}
                  active={filter === `label:${l}`}
                  onClick={() => setParam({ filter: `label:${l}` })}
                />
              ))}
            </RailGroup>
          )}
          {(directCount > 0 || filter === 'direct') && (
            <RailGroup title="Over HTTP">
              <RailItem label="Direct downloads" count={directCount} active={filter === 'direct'} onClick={() => setParam({ filter: 'direct' })} />
            </RailGroup>
          )}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
          <div className="border-b p-2 md:hidden">
            <Select value={filter} onValueChange={(v) => setParam({ filter: v === 'all' ? null : v })}>
              <SelectTrigger className="w-full" aria-label="Show">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All ({list.length})</SelectItem>
                {STATES.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label} ({counts(s.states)})
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>What it is</SelectLabel>
                  {KINDS.map((k) => (
                    <SelectItem key={k.id} value={`kind:${k.id}`}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
                {(directCount > 0 || filter === 'direct') && <SelectItem value="direct">Direct downloads ({directCount})</SelectItem>}
                {labels.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Labels</SelectLabel>
                    {labels.map((l) => (
                      <SelectItem key={l} value={`label:${l}`}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>

          {filter === 'direct' ? (
            <DirectList downloads={directs.data ?? []} q={q} />
          ) : shown.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <Empty icon={<DownloadIcon />} title={list.length ? 'Nothing matches' : 'No downloads yet'}>
                {list.length ? (
                  <>
                    No download is {q ? `named “${q}” ` : ''}in this view.{' '}
                    <button
                      type="button"
                      className="font-medium text-foreground underline underline-offset-2"
                      onClick={() => {
                        setQ('')
                        setParam({ filter: null })
                      }}
                    >
                      Show all
                    </button>
                  </>
                ) : (
                  <>
                    Torrents a device plays show up here and stay after the player leaves. Add one, or drop a .torrent file on this page,
                    to download it without playing.
                  </>
                )}
              </Empty>
            </div>
          ) : desktop ? (
            <DataTable
              label="Downloads"
              data={shown}
              columns={columns}
              getRowId={(d) => d.infoHash}
              storageKey="playpex.downloads.columns"
              defaultHidden={['downloaded', 'uploaded', 'added', 'completedAt', 'lastActive', 'label', 'addedBy', 'savePath']}
              selection={selection}
              onSelectionChange={setSelection}
              active={open}
              onActiveChange={(id) => openPane(id)}
              onOpen={(id) => openPane(id)}
              onKey={(key, ids) => {
                if (key === 'space') toggleRun(ids)
                else if (key === 'delete') setRemoving(ids)
                else if (byHash.get(ids[0])) playDownload(byHash.get(ids[0])!)
              }}
              actions={rowActions}
              className="flex-1"
            />
          ) : (
            <PhoneList downloads={shown} onOpen={(h) => openPane(h)} />
          )}

          {desktop && open && byHash.has(open) && (
            <div className="relative flex shrink-0 flex-col border-t" style={{ height: pane.height }}>
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the details"
                onPointerDown={pane.drag}
                className="absolute inset-x-0 -top-1.5 z-20 h-3 cursor-row-resize after:absolute after:inset-x-0 after:top-1.5 after:h-px after:bg-transparent hover:after:bg-primary/60"
              />
              <DownloadPane hash={open} tab={tab} onTabChange={(t) => setParam({ tab: t === 'general' ? null : t })} onClose={() => openPane(null)} className="h-full" />
            </div>
          )}

          <StatusBar list={list} />
        </div>
      </div>

      {/* phones: the detail as a sheet */}
      {!desktop && (
        <Sheet open={!!open && byHash.has(open)} onOpenChange={(o) => !o && openPane(null)}>
          <SheetContent side="bottom" className="flex h-[85svh] flex-col gap-0 p-0">
            <SheetHeader className="border-b">
              <SheetTitle className="pr-6 break-all">{open ? (byHash.get(open)?.name ?? open) : ''}</SheetTitle>
              <SheetDescription>{open && byHash.get(open) ? stateText(byHash.get(open)!) : ''}</SheetDescription>
            </SheetHeader>
            {open && (
              <>
                <DownloadPane hash={open} tab={tab} onTabChange={(t) => setParam({ tab: t === 'general' ? null : t })} className="min-h-0 flex-1" />
                <div className="flex gap-2 border-t p-3">
                  {byHash.get(open) && canPause(byHash.get(open)!) ? (
                    <Button variant="outline" className="flex-1" onClick={() => actions.pause.mutate([open])}>
                      <Pause /> Pause
                    </Button>
                  ) : (
                    <Button variant="outline" className="flex-1" disabled={!byHash.get(open) || !canStart(byHash.get(open)!)} onClick={() => actions.start.mutate([open])}>
                      <Play /> Start
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setLabelling([open])}>
                    <Tag /> Label
                  </Button>
                  <Button variant="outline" className="text-destructive" onClick={() => setRemoving([open])}>
                    <Trash2 /> Remove
                  </Button>
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80 backdrop-blur-sm">
          <p className="flex items-center gap-2 text-lg font-medium">
            <FileUp className="size-5 text-primary" /> Drop the .torrent to add it
          </p>
        </div>
      )}

      <AddDownloadDialog
        key={addKey}
        open={adding}
        file={dropped}
        labels={labels}
        onOpenChange={(o) => {
          setAdding(o)
          if (!o) setDropped(null)
        }}
      />
      <RemoveDialog
        downloads={(removing ?? []).map((h) => byHash.get(h)).filter((d): d is Download => !!d)}
        onClose={() => setRemoving(null)}
        onRemove={(data) => {
          if (removing) actions.remove.mutate({ hashes: removing, data })
          if (open && removing?.includes(open)) openPane(null)
          setSelection((s) => s.filter((h) => !removing?.includes(h)))
          setRemoving(null)
        }}
      />
      <RulesDialog
        downloads={(ruling ?? []).map((h) => byHash.get(h)).filter((d): d is Download => !!d)}
        canLimit={caps.can('torrentLimits')}
        engine={caps.engine}
        onClose={() => setRuling(null)}
        onSave={(body) => {
          if (ruling) actions.rules.mutate({ hashes: ruling, body })
          setRuling(null)
        }}
      />
      <LabelDialog
        downloads={(labelling ?? []).map((h) => byHash.get(h)).filter((d): d is Download => !!d)}
        labels={labels}
        onClose={() => setLabelling(null)}
        onSave={(label) => {
          if (labelling) actions.label.mutate({ hashes: labelling, label })
          setLabelling(null)
        }}
      />
    </div>
  )
}

// Phones: one line of state, speed and time left under each name
function PhoneList({ downloads, onOpen }: { downloads: Download[]; onOpen: (hash: string) => void }) {
  return (
    <ul className="divide-y">
      {downloads.map((d) => (
        <li key={d.infoHash}>
          <button type="button" onClick={() => onOpen(d.infoHash)} className="w-full space-y-1.5 px-3 py-2.5 text-left active:bg-muted">
            <div className="truncate text-sm font-medium">{d.name ?? d.infoHash}</div>
            <div className="flex items-center gap-2.5">
              <SwarmStrip map={d.pieceMap} progress={d.progress} tone={toneOf(d)} className="flex-1" />
              <span className="w-11 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {d.progress === null ? '' : `${Math.floor(d.progress * 100)} %`}
              </span>
            </div>
            <div className="flex gap-3 text-xs text-muted-foreground tabular-nums">
              <span className={cn(d.state === 'error' && 'text-destructive')}>{stateText(d)}</span>
              {d.downloadSpeed > 0 && <span className="text-down">↓ {speed(d.downloadSpeed)}</span>}
              {d.uploadSpeed > 0 && <span className="text-up">↑ {speed(d.uploadSpeed)}</span>}
              {d.eta !== null && d.state === 'downloading' && <span>{clock(d.eta)} left</span>}
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

// Totals, the speed limits, the download folder's disk, "Pause all"
function StatusBar({ list }: { list: Download[] }) {
  const client = useQueryClient()
  const overview = useOverview()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => unwrap(api.GET('/admin/settings')) })
  const dl = settings.data?.settings.downloads
  const totals = list.reduce((s, d) => ({ down: s.down + d.downloadSpeed, up: s.up + d.uploadSpeed }), { down: 0, up: 0 })
  const disk = overview.data?.disks.find((d) => d.id === 'downloads')
  const engine = overview.data?.downloads
  const save = useMutation({
    mutationFn: (downloads: Partial<NonNullable<typeof dl>>) => unwrap(api.PUT('/admin/settings', { body: { downloads } })),
    onSuccess: (_, patch) => {
      if ('paused' in patch) toast.success(patch.paused ? 'Downloads paused (streams still play)' : 'Downloads resumed')
      else toast.success('Speed limits saved')
      client.invalidateQueries({ queryKey: ['settings'] })
      client.invalidateQueries({ queryKey: ['downloads'] })
      client.invalidateQueries({ queryKey: ['overview'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const limit = (kbps: number | undefined) => (kbps ? ` / ${speed(kbps * 1024)}` : '')
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground tabular-nums">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="flex items-center gap-4 rounded-md px-1 py-0.5 hover:bg-muted hover:text-foreground" title="Speed limits">
            <span className="flex items-center gap-1">
              <ArrowDown className="size-3.5 text-down" />
              <span className="text-foreground">{speed(totals.down)}</span>
              {limit(dl?.downLimitKBps)}
            </span>
            <span className="flex items-center gap-1">
              <ArrowUp className="size-3.5 text-up" />
              <span className="text-foreground">{speed(totals.up)}</span>
              {limit(dl?.upLimitKBps)}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          {dl && <LimitsForm key={`${dl.downLimitKBps}-${dl.upLimitKBps}`} down={dl.downLimitKBps} up={dl.upLimitKBps} canLimit={!!engine?.capabilities?.rateLimits} engine={engine?.engine ?? null} saving={save.isPending} onSave={(v) => save.mutate(v)} />}
        </PopoverContent>
      </Popover>
      {disk && (
        <span className="flex items-center gap-1.5" title={disk.path}>
          <HardDrive className="size-3.5" /> {bytes(disk.free)} free
        </span>
      )}
      {engine?.engine && <span className="hidden sm:inline">Engine {engine.engine}</span>}
      <label className="ml-auto flex items-center gap-2">
        {save.isPending && 'paused' in (save.variables ?? {}) ? <Spinner className="size-3" /> : null}
        <span>Pause all downloads</span>
        <Switch size="sm" checked={dl?.paused ?? false} disabled={!dl || save.isPending} onCheckedChange={(v) => save.mutate({ paused: v })} />
      </label>
    </div>
  )
}

function LimitsForm({
  down,
  up,
  canLimit,
  engine,
  saving,
  onSave,
}: {
  down: number
  up: number
  canLimit: boolean
  engine: string | null
  saving: boolean
  onSave: (v: { downLimitKBps: number; upLimitKBps: number }) => void
}) {
  const [d, setD] = useState(down ? String(down) : '')
  const [u, setU] = useState(up ? String(up) : '')
  const value = (s: string) => Math.max(0, Math.floor(Number(s) || 0))
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSave({ downLimitKBps: value(d), upLimitKBps: value(u) })
      }}
    >
      <div>
        <p className="text-sm font-medium">Speed limits</p>
        <p className="text-xs text-muted-foreground">Every torrent together, in KB/s. Empty means no limit.</p>
      </div>
      {!canLimit && (
        <p className="rounded-md bg-muted px-2.5 py-2 text-xs">
          The {engine ?? 'running'} engine can't limit speed. Choose torrentd in Settings › Downloads to use these.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="limit-down">Download</Label>
          <Input id="limit-down" inputMode="numeric" value={d} placeholder="No limit" disabled={!canLimit} onChange={(e) => setD(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="limit-up">Upload</Label>
          <Input id="limit-up" inputMode="numeric" value={u} placeholder="No limit" disabled={!canLimit} onChange={(e) => setU(e.target.value.replace(/\D/g, ''))} />
        </div>
      </div>
      <Button type="submit" size="sm" className="w-full" disabled={!canLimit || saving}>
        Save limits
      </Button>
    </form>
  )
}

function RemoveDialog({ downloads, onClose, onRemove }: { downloads: Download[]; onClose: () => void; onRemove: (data: 'keep' | 'delete') => void }) {
  const one = downloads.length === 1 ? downloads[0] : null
  return (
    <AlertDialog open={downloads.length > 0} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{one ? 'Remove this download?' : `Remove ${downloads.length} downloads?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {one ? <span className="font-medium break-all text-foreground">{one.name ?? one.infoHash}</span> : null}
            {one ? ': the' : 'The'} server forgets {one ? 'it' : 'them'}. Keep the files in the download folder, or delete them too. Devices
            playing {one ? 'it' : 'them'} stop.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="outline" onClick={() => onRemove('keep')}>
            Remove, keep files
          </Button>
          <Button variant="destructive" onClick={() => onRemove('delete')}>
            Delete files too
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function LabelDialog({
  downloads,
  labels,
  onClose,
  onSave,
}: {
  downloads: Download[]
  labels: string[]
  onClose: () => void
  onSave: (label: string | null) => void
}) {
  const current = downloads.length && downloads.every((d) => d.label === downloads[0].label) ? (downloads[0].label ?? '') : ''
  const [value, setValue] = useState(current)
  const opened = useRef(false)
  useEffect(() => {
    if (downloads.length && !opened.current) setValue(current)
    opened.current = downloads.length > 0
  }, [downloads.length, current])
  return (
    <Dialog open={downloads.length > 0} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            onSave(value.trim() || null)
          }}
        >
          <DialogHeader>
            <DialogTitle>{downloads.length === 1 ? 'Label' : `Label ${downloads.length} downloads`}</DialogTitle>
            <DialogDescription>Labels group downloads in the list's filters. Any words, up to 40 characters.</DialogDescription>
          </DialogHeader>
          <Input autoFocus value={value} maxLength={40} placeholder="Movies for the weekend" onChange={(e) => setValue(e.target.value)} />
          {labels.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {labels.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setValue(l)}
                  className={cn('rounded-md border px-2 py-0.5 text-xs hover:bg-muted', value === l && 'border-primary bg-primary/10')}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
          <DialogFooter>
            {current && (
              <Button type="button" variant="ghost" className="mr-auto" onClick={() => onSave(null)}>
                Take the label off
              </Button>
            )}
            <Button type="submit">Save label</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

