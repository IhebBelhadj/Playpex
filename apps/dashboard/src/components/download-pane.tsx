import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, FileVideo, File as FileIcon, Play, RefreshCw, Subtitles, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Loading, QueryError, Spinner } from '@/components/common'
import { PeersTab, PiecesTab, SpeedTab, TrackersTab } from '@/components/download-tabs'
import { usePlayer } from '@/components/player'
import { SwarmStrip, toneOf } from '@/components/swarm-strip'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, errorMessage, unwrap } from '@/lib/api'
import { magnetOf, stateText, titleOf, useDeviceNames, type Download } from '@/lib/downloads'
import { ago, bytes, clock, dateTime, speed } from '@/lib/format'
import { cn } from '@/lib/utils'

// A download's detail (docs/dashboard-plan.md §4.3): under the list on a
// desktop, a sheet's content on a phone: General, Files, then the swarm tabs
// of components/download-tabs.tsx (engine port v2).

export const PANE_TABS = ['general', 'files', 'peers', 'trackers', 'pieces', 'speed'] as const
export type PaneTab = (typeof PANE_TABS)[number]

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error(`Couldn't copy the ${what.toLowerCase()}`),
  )
}

export function DownloadPane({
  hash,
  tab,
  onTabChange,
  onClose,
  className,
}: {
  hash: string
  tab: PaneTab
  onTabChange: (tab: PaneTab) => void
  onClose?: () => void
  className?: string
}) {
  const detail = useQuery({
    queryKey: ['download', hash],
    queryFn: () => unwrap(api.GET('/downloads/{infoHash}', { params: { path: { infoHash: hash } } })),
    refetchInterval: 2000,
  })
  const d = detail.data
  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as PaneTab)} className={cn('flex min-h-0 flex-col gap-0', className)}>
      <div className="flex items-center gap-3 border-b px-3 py-1.5">
        <TabsList variant="line" className="h-8 max-w-full overflow-x-auto [scrollbar-width:none]">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="files">
            Files
            {d?.fileCount ? <span className="ml-1 text-muted-foreground tabular-nums">{d.fileCount}</span> : null}
          </TabsTrigger>
          <TabsTrigger value="peers">
            Peers
            {d && d.peers > 0 ? <span className="ml-1 text-muted-foreground tabular-nums">{d.peers}</span> : null}
          </TabsTrigger>
          <TabsTrigger value="trackers">Trackers</TabsTrigger>
          <TabsTrigger value="pieces">Pieces</TabsTrigger>
          <TabsTrigger value="speed">Speed</TabsTrigger>
        </TabsList>
        <p className="hidden min-w-0 flex-1 truncate text-sm text-muted-foreground md:block" title={d?.name ?? hash}>
          {d?.name ?? hash}
        </p>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="Close the details" title="Close (Esc)" onClick={onClose} className="ml-auto">
            <X />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail.isPending ? (
          <div className="p-4">
            <Loading rows={2} />
          </div>
        ) : detail.error ? (
          <div className="p-4">
            <QueryError error={detail.error} title="Could not load this download" />
          </div>
        ) : d ? (
          <>
            <TabsContent value="general" className="p-4">
              <General d={d} />
            </TabsContent>
            <TabsContent value="files" className="p-0">
              <Files d={d} files={d.files} />
            </TabsContent>
            <TabsContent value="peers" className="p-0">
              <PeersTab d={d} />
            </TabsContent>
            <TabsContent value="trackers" className="p-0">
              <TrackersTab d={d} />
            </TabsContent>
            <TabsContent value="pieces" className="p-0">
              <PiecesTab d={d} />
            </TabsContent>
            <TabsContent value="speed" className="p-0">
              <SpeedTab d={d} />
            </TabsContent>
          </>
        ) : null}
      </div>
    </Tabs>
  )
}

function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm tabular-nums">{children}</dd>
    </div>
  )
}

function General({ d }: { d: Download }) {
  const client = useQueryClient()
  const deviceName = useDeviceNames()
  const rule = useMutation({
    mutationFn: (value: boolean) =>
      unwrap(api.PATCH('/downloads/{infoHash}', { params: { path: { infoHash: d.infoHash } }, body: { removeWhenWatched: value } })),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['download', d.infoHash] })
      client.invalidateQueries({ queryKey: ['downloads'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const recheck = useMutation({
    mutationFn: () => unwrap(api.POST('/downloads/{infoHash}/recheck', { params: { path: { infoHash: d.infoHash } } })),
    onSuccess: () => {
      toast.success('Checking its data again')
      client.invalidateQueries({ queryKey: ['download', d.infoHash] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const running = ['downloading', 'seeding', 'checking'].includes(d.state)
  const pct = d.progress === null ? null : Math.floor(d.progress * 1000) / 10
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium">{stateText(d)}</span>
          <span className="text-muted-foreground tabular-nums">
            {pct === null ? 'Size not known yet' : `${bytes(d.doneBytes)} of ${bytes(d.sizeBytes)} · ${pct} %`}
          </span>
        </div>
        <SwarmStrip map={d.pieceMap} progress={d.progress} tone={toneOf(d)} className="h-3" />
        {d.error && <p className="text-sm text-destructive">{d.error}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-5">
        <Fact label="Download speed">
          <span className="text-down">{speed(d.downloadSpeed)}</span>
        </Fact>
        <Fact label="Upload speed">
          <span className="text-up">{speed(d.uploadSpeed)}</span>
        </Fact>
        <Fact label="Time left">{d.eta !== null && d.state === 'downloading' ? clock(d.eta) : '—'}</Fact>
        <Fact label="Connected">
          {d.peers} {d.peers === 1 ? 'peer' : 'peers'}
          {d.seeds ? `, ${d.seeds} ${d.seeds === 1 ? 'seed' : 'seeds'}` : ''}
        </Fact>
        <Fact label="Uploaded">
          {bytes(d.uploadedBytes)}
          {d.ratio !== null && <span className="text-muted-foreground"> · ratio {d.ratio.toFixed(2)}</span>}
        </Fact>
        <Fact label="Title">{titleOf(d) ?? <span className="text-muted-foreground">—</span>}</Fact>
        <Fact label="Added">
          <span title={dateTime(d.addedAt)}>{ago(d.addedAt)}</span>
          {d.addedBy && <span className="text-muted-foreground"> by {deviceName(d.addedBy)}</span>}
        </Fact>
        <Fact label="Completed">{d.completedAt ? <span title={dateTime(d.completedAt)}>{ago(d.completedAt)}</span> : '—'}</Fact>
        <Fact label="Last active">{d.lastActiveAt ? ago(d.lastActiveAt) : 'Never'}</Fact>
        <Fact label="Label">{d.label ?? <span className="text-muted-foreground">None</span>}</Fact>
      </dl>
      <dl className="grid gap-3 md:grid-cols-2">
        <CopyLine label="Saved in" value={d.savePath} what="Path" />
        <CopyLine label="Info hash" value={d.infoHash} what="Info hash" mono />
      </dl>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-4">
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={d.removeWhenWatched} disabled={rule.isPending} onCheckedChange={(v) => rule.mutate(v)} />
          <span>
            Remove when watched
            <span className="block text-xs text-muted-foreground">Deleted with its files once a player reaches the end.</span>
          </span>
        </label>
        <Button variant="outline" size="sm" onClick={() => copy(magnetOf(d), 'Magnet link')}>
          <Copy /> Copy magnet link
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!running || recheck.isPending}
          title={running ? 'Verify every piece on disk again' : 'Start it first: only a running torrent is checked'}
          onClick={() => recheck.mutate()}
        >
          {recheck.isPending ? <Spinner /> : <RefreshCw />} Check the data again
        </Button>
      </div>
    </div>
  )
}

function CopyLine({ label, value, what, mono }: { label: string; value: string; what: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 flex min-w-0 items-center gap-1">
        <span className={cn('min-w-0 truncate text-sm', mono && 'font-mono text-xs')} title={value}>
          {value}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label={`Copy the ${what.toLowerCase()}`} onClick={() => copy(value, what)}>
          <Copy />
        </Button>
      </dd>
    </div>
  )
}

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv)$/i
const SUBTITLE = /\.(srt|ass|ssa|vtt|sub|idx)$/i

type DetailFile = NonNullable<import('@/lib/api').Schemas['DownloadDetail']['files']>[number]

function Files({ d, files }: { d: Download; files: DetailFile[] | null }) {
  const client = useQueryClient()
  const player = usePlayer()
  const [chosen, setChosen] = useState<string[] | null>(null)
  const list = useMemo(() => files ?? [], [files])
  const current = list.filter((f) => f.selected).map((f) => f.path)
  const selected = chosen ?? current
  const changed = chosen !== null && JSON.stringify([...chosen].sort()) !== JSON.stringify([...current].sort())
  const select = useMutation({
    mutationFn: (paths: string[]) =>
      unwrap(api.PUT('/downloads/{infoHash}/files', { params: { path: { infoHash: d.infoHash } }, body: { files: paths.length === list.length ? null : paths } })),
    onSuccess: () => {
      toast.success('Files chosen')
      setChosen(null)
      client.invalidateQueries({ queryKey: ['download', d.infoHash] })
      client.invalidateQueries({ queryKey: ['downloads'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  if (files === null) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {d.state === 'downloading' ? 'Waiting for the torrent’s metadata: its files arrive from the swarm.' : 'Start it to get its file list from the swarm.'}
      </p>
    )
  }
  const shown = (path: string) => (d.name && path.startsWith(d.name + '/') ? path.slice(d.name.length + 1) : path)
  const total = list.filter((f) => selected.includes(f.path)).reduce((s, f) => s + f.size, 0)
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-card px-3 py-1.5 text-sm">
        <Checkbox
          aria-label="Every file"
          checked={selected.length === list.length ? true : selected.length ? 'indeterminate' : false}
          onCheckedChange={(v) => setChosen(v ? list.map((f) => f.path) : [])}
        />
        <span className="flex-1 text-muted-foreground tabular-nums">
          {selected.length} of {list.length} files · {bytes(total)}
        </span>
        {changed && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setChosen(null)}>
              Undo
            </Button>
            <Button size="sm" disabled={select.isPending || selected.length === 0} onClick={() => select.mutate(selected)}>
              Download these
            </Button>
          </>
        )}
      </div>
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <tbody>
          {list.map((f) => {
            const on = selected.includes(f.path)
            const progress = f.doneBytes === null ? null : f.doneBytes / Math.max(f.size, 1)
            const Icon = VIDEO.test(f.path) ? FileVideo : SUBTITLE.test(f.path) ? Subtitles : FileIcon
            return (
              <tr key={f.path} className={cn('hover:bg-muted/50', !on && 'text-muted-foreground')}>
                <td className="w-9 border-b px-3 py-1.5">
                  <Checkbox
                    checked={on}
                    aria-label={`Download ${f.name}`}
                    onCheckedChange={(v) => setChosen(v ? [...selected, f.path] : selected.filter((p) => p !== f.path))}
                  />
                </td>
                <td className="max-w-0 border-b px-2 py-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate" title={f.path}>
                      {shown(f.path)}
                    </span>
                  </div>
                </td>
                <td className="w-40 border-b px-2 py-1.5">
                  {on && <SwarmStrip map={null} progress={progress ?? 0} tone={progress === 1 ? 'up' : toneOf(d) === 'fault' ? 'fault' : toneOf(d)} />}
                </td>
                <td className="w-16 border-b px-2 py-1.5 text-right">{on && progress !== null ? `${Math.floor(progress * 100)} %` : ''}</td>
                <td className="w-24 border-b px-2 py-1.5 text-right whitespace-nowrap">{bytes(f.size)}</td>
                <td className="w-10 border-b pr-2 text-right">
                  {VIDEO.test(f.path) && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Play ${f.name}`}
                      title="Play here (it downloads what it plays first)"
                      onClick={() => player.play({ ref: f.ref, title: f.name, detail: d.name ?? undefined })}
                    >
                      <Play />
                    </Button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
