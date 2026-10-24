import { ArrowDown, ArrowUp, Copy, Cpu, Film, HardDrive, Server } from 'lucide-react'
import { toast } from 'sonner'
import { Dot, Loading, PageHeader, QueryError, Stat } from '@/components/common'
import { UpdateNotice, useHost } from '@/components/desktop'
import { SourcesNotice } from '@/components/sources-notice'
import { useOverview } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Overview } from '@/lib/api'
import { ago, bytes, duration, speed } from '@/lib/format'
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
            <span className="font-mono tabular-nums">{p.cpuPercent.toFixed(1)} %</span>
          </div>
          <Progress value={Math.min(100, p.cpuPercent / s.cpus)} />
        </div>
        <div className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground">System memory</span>
            <span className="font-mono tabular-nums">
              {bytes(memUsed)} / {bytes(s.totalMemBytes)}
            </span>
          </div>
          <Progress value={(memUsed / s.totalMemBytes) * 100} />
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Server process memory</span>
          <span className="font-mono tabular-nums">{bytes(p.rssBytes)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Load average</span>
          <span className="font-mono tabular-nums">{s.loadAverage.map((l) => l.toFixed(2)).join(' · ')}</span>
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
                <span className={`font-mono text-xs tabular-nums ${low ? 'text-destructive' : 'text-muted-foreground'}`}>
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sessions" value={data.activity.sessions} hint={`${data.activity.torrents} torrents running`} />
        <Stat label="Peers" value={data.network.peers} hint={`${data.activity.eventClients} live connections`} />
        <Stat
          label="Download"
          value={
            <span className="flex items-center gap-1">
              <ArrowDown className="size-4 text-muted-foreground" />
              {speed(data.network.downloadSpeed)}
            </span>
          }
          hint={`${bytes(data.network.downloaded)} since start`}
        />
        <Stat
          label="Upload"
          value={
            <span className="flex items-center gap-1">
              <ArrowUp className="size-4 text-muted-foreground" />
              {speed(data.network.uploadSpeed)}
            </span>
          }
          hint={`${bytes(data.network.uploaded)} since start`}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Addresses server={data.server} />
        <Machine data={data} />
        <Disks disks={data.disks} />
        <Services data={data} />
      </div>
    </>
  )
}
