import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronRight, Copy, Cpu, Film, HardDrive, Server } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Dot, Loading, PageHeader, QueryError } from '@/components/common'
import { UpdateNotice, useHost } from '@/components/desktop'
import { SourcesNotice } from '@/components/sources-notice'
import { useOverview } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, unwrap, type Overview } from '@/lib/api'
import { ago, bytes, clock, duration, speed } from '@/lib/format'
import { copy } from '@/lib/utils-dom'

const DISK_LABELS: Record<string, string> = { downloads: 'Downloads', config: 'Settings & database', logs: 'Logs' }

// How devices on the LAN find the server (mDNS + the UDP responder)
function Discovery({ discovery }: { discovery: Overview['server']['discovery'] }) {
  if (discovery.reason === 'lanSharing' || discovery.reason === 'recovery') {
    return null
  }
  if (!discovery.enabled) {
    return <Badge variant="secondary">Not advertised</Badge>
  }
  const problems = [
    discovery.mdns.state === 'error' ? `mDNS: ${discovery.mdns.error}` : null,
    discovery.udp.state === 'error' ? `UDP: ${discovery.udp.error}` : null,
  ].filter((p): p is string => p !== null)
  const working = discovery.mdns.state !== 'error' || discovery.udp.state !== 'error'
  return (
    <>
      <Badge variant={problems.length ? 'outline' : 'default'} title={discovery.mdns.name ? `Advertised as “${discovery.mdns.name}”` : undefined}>
        <Dot state={problems.length ? (working ? 'warn' : 'bad') : 'ok'} />
        {working ? 'Found automatically by devices' : 'Devices can’t find it automatically'}
      </Badge>
      {problems.length > 0 && (
        <p className="w-full text-xs text-muted-foreground">
          {problems.join(' · ')}.{' '}
          {working
            ? `Devices still find it through ${discovery.mdns.state === 'error' ? 'UDP' : 'mDNS'}.`
            : 'Devices can still connect by typing an address below.'}
        </p>
      )}
    </>
  )
}

function Addresses({ server }: { server: Overview['server'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="size-4" /> Server
        </CardTitle>
        <CardDescription>
          Version {server.version} · up {duration(server.uptimeS)} · port {server.port}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant={server.lanSharing ? 'default' : 'secondary'}>{server.lanSharing ? 'Shared on the LAN' : 'This machine only'}</Badge>
          <Discovery discovery={server.discovery} />
        </div>
        <div className="space-y-1.5">
          {server.urls.map((url) => (
            <div key={url} className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-1.5">
              <code className="truncate font-mono text-xs">{url}</code>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Copy ${url}`}
                onClick={async () => ((await copy(url)) ? toast.success('Copied') : toast.error('The browser refused to copy'))}
              >
                <Copy />
              </Button>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Clients on your network connect to one of these addresses.</p>
      </CardContent>
    </Card>
  )
}

function Machine({ data }: { data: Overview }) {
  const { process: p, system: s } = data
  const memUsed = s.totalMemBytes - s.freeMemBytes
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-4" /> Machine
        </CardTitle>
        <CardDescription>
          {s.hostname} · {s.platform} {s.arch} · {s.cpus} CPUs · Node {p.node}
          {p.electron ? ` · Electron ${p.electron}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Server process CPU</span>
            <span className="tabular-nums">{p.cpuPercent.toFixed(1)} %</span>
          </div>
          <Progress value={Math.min(100, p.cpuPercent / s.cpus)} />
        </div>
        <div className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground">System memory</span>
            <span className="tabular-nums">
              {bytes(memUsed)} / {bytes(s.totalMemBytes)}
            </span>
          </div>
          <Progress value={(memUsed / s.totalMemBytes) * 100} />
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Server process memory</span>
          <span className="tabular-nums">{bytes(p.rssBytes)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Load average</span>
          <span className="tabular-nums">{s.loadAverage.map((l) => l.toFixed(2)).join(' · ')}</span>
        </div>
      </CardContent>
    </Card>
  )
}

function Disks({ disks }: { disks: Overview['disks'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-4" /> Disk space
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {disks.map((d) => {
          const used = d.total && d.free !== null ? ((d.total - d.free) / d.total) * 100 : 0
          const low = d.free !== null && d.free < 5 * 1024 ** 3
          return (
            <div key={d.id} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span>{DISK_LABELS[d.id] ?? d.id}</span>
                <span className={`text-xs tabular-nums ${low ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {bytes(d.free)} free of {bytes(d.total)}
                </span>
              </div>
              <Progress value={used} className={low ? '[&>*]:bg-destructive' : undefined} />
              <p className="truncate font-mono text-xs text-muted-foreground" title={d.path}>
                {d.path}
              </p>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function Services({ data }: { data: Overview }) {
  const ff = data.ffmpeg
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Film className="size-4" /> Transcoding & providers
        </CardTitle>
        <CardDescription>
          Since the server started. Providers are checked when clients use them; a plugin&apos;s sites show once it has asked them something.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
          <Dot state={ff.available ? 'ok' : 'bad'} className="mt-1.5" />
          <div className="min-w-0">
            <div>{ff.available ? `ffmpeg ${ff.version} (${ff.source})` : 'ffmpeg not found'}</div>
            <div className="text-xs text-muted-foreground">
              {ff.available
                ? 'Dolby / DTS audio is converted for clients that can’t play it.'
                : 'Releases with Dolby / DTS audio play without sound. Install ffmpeg or set its path in Settings › Transcoding.'}
            </div>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Last success</TableHead>
              <TableHead className="hidden sm:table-cell">Last failure</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.providers.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <Dot state={p.ok === null ? 'idle' : p.ok ? 'ok' : 'bad'} />
                    {p.name}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{p.ok === null ? 'not used yet' : ago(p.lastSuccess)}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {p.lastFailure ? `${ago(p.lastFailure)} · ${p.lastError}` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

type Problem = { text: ReactNode; fix?: { to: string; label: string } }

// "Is everything fine?": what needs the admin, first (docs/dashboard-plan.md §7)
function Health({ data }: { data: Overview }) {
  const places = useQuery({ queryKey: ['storage-places'], queryFn: () => unwrap(api.GET('/admin/storage/places')), refetchInterval: 60_000 })
  const problems: Problem[] = []
  const dl = data.downloads
  if (!dl.engine) problems.push({ text: <>No torrent engine runs{dl.engineError ? `: ${dl.engineError}` : ''}. Nothing downloads.</>, fix: { to: '/settings/downloads', label: 'Downloads settings' } })
  else if (dl.engineError)
    problems.push({ text: <>The {dl.requestedEngine} engine couldn’t start ({dl.engineError}); {dl.engine} runs instead.</>, fix: { to: '/settings/downloads', label: 'Downloads settings' } })
  if (!data.ffmpeg.available)
    problems.push({ text: 'ffmpeg isn’t there: Dolby / DTS sound plays silent, and browsers can’t play MKV files.', fix: { to: '/settings/transcoding', label: 'Transcoding settings' } })
  for (const d of data.disks)
    if (d.free !== null && d.free < 5 * 1024 ** 3)
      problems.push({ text: <>Only {bytes(d.free)} left on the disk of {DISK_LABELS[d.id]?.toLowerCase() ?? d.id}.</>, fix: d.id === 'downloads' ? { to: '/library?place=downloads', label: 'Free some space' } : undefined })
  for (const p of places.data?.places ?? [])
    if (p.status === 'offline') problems.push({ text: <>The library folder {p.name} is offline ({p.root}).</>, fix: { to: '/library', label: 'Library' } })
  const failing = data.providers.filter((p) => p.lastFailure && (!p.lastSuccess || p.lastFailure > p.lastSuccess))
  for (const p of failing) problems.push({ text: <>{p.name} fails: {p.lastError ?? 'no answer'} ({ago(p.lastFailure)}).</> })
  if (dl.paused) problems.push({ text: 'Downloads are paused (streams still play).', fix: { to: '/downloads', label: 'Downloads' } })

  if (!problems.length) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="size-4 text-up" /> Everything is running.
      </p>
    )
  }
  return (
    <ul className="divide-y overflow-hidden rounded-xl border border-warning/40 bg-warning/5">
      {problems.map((p, i) => (
        <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{p.text}</span>
          {p.fix && (
            <Link to={p.fix.to} className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline">
              {p.fix.label} <ChevronRight className="size-3.5" />
            </Link>
          )}
        </li>
      ))}
    </ul>
  )
}

// Right now: the traffic, what downloads, what plays
function RightNow({ data }: { data: Overview }) {
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => unwrap(api.GET('/sessions')), refetchInterval: 5000 })
  const playing = (sessions.data ?? []).filter((s) => s.streaming || (s.playback && !s.playback.paused))
  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <Link to="/downloads" className="group rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Traffic</h2>
          <span className="text-xs text-muted-foreground group-hover:text-foreground">
            {data.downloads.active} running · {data.downloads.queued} waiting <ChevronRight className="inline size-3.5" />
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-8 gap-y-2 tabular-nums">
          <div>
            <div className="flex items-center gap-1.5 text-2xl font-semibold tracking-tight">
              <ArrowDown className="size-5 text-down" /> {speed(data.network.downloadSpeed)}
            </div>
            <div className="text-xs text-muted-foreground">{bytes(data.network.downloaded)} since the server started</div>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-2xl font-semibold tracking-tight">
              <ArrowUp className="size-5 text-up" /> {speed(data.network.uploadSpeed)}
            </div>
            <div className="text-xs text-muted-foreground">
              {bytes(data.network.uploaded)} · {data.network.peers} {data.network.peers === 1 ? 'peer' : 'peers'}
            </div>
          </div>
        </div>
      </Link>
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Playing now</h2>
          <Link to="/activity" className="text-xs text-muted-foreground hover:text-foreground">
            Activity <ChevronRight className="inline size-3.5" />
          </Link>
        </div>
        {playing.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nothing plays right now.</p>
        ) : (
          <ul className="mt-2 space-y-2.5">
            {playing.slice(0, 4).map((s) => {
              const p = s.playback
              const title = p?.title || s.file?.split('/').pop() || s.torrentName || 'Something'
              const at = p?.durationS ? Math.min(1, (p.positionS ?? 0) / p.durationS) : null
              return (
                <li key={s.id} className="space-y-1">
                  <div className="flex items-baseline gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium" title={title}>
                      {title}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{s.deviceName ?? s.deviceId}</span>
                  </div>
                  {at !== null && (
                    <div className="flex items-center gap-2">
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-(--strip-track)">
                        <span className="block h-full rounded-full bg-primary" style={{ width: `${at * 100}%` }} />
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {clock(p?.positionS)} / {clock(p?.durationS)}
                      </span>
                    </div>
                  )}
                </li>
              )
            })}
            {playing.length > 4 && <li className="text-xs text-muted-foreground">And {playing.length - 4} more</li>}
          </ul>
        )}
      </div>
    </section>
  )
}

export function OverviewPage() {
  const overview = useOverview()
  const host = useHost()
  if (overview.isPending) return <Loading rows={4} />
  if (overview.error) return <QueryError error={overview.error} />
  const data = overview.data
  return (
    <>
      <PageHeader title="Overview" description={data.server.name} />
      <UpdateNotice host={host.data} streams={data.activity.sessions} />
      {data.sources.notice && <SourcesNotice />}
      <Health data={data} />
      <RightNow data={data} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Addresses server={data.server} />
        <Machine data={data} />
        <Disks disks={data.disks} />
        <Services data={data} />
      </div>
    </>
  )
}
