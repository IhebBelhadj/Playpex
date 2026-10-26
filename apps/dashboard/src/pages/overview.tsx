import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowDown, ArrowUp, ChevronRight, Copy } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Dot, Loading, PageHeader, QueryError } from '@/components/common'
import { UpdateNotice, useHost } from '@/components/desktop'
import { SourcesNotice } from '@/components/sources-notice'
import { useOverview } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, unwrap, type Overview } from '@/lib/api'
import { ago, bytes, clock, duration, speed } from '@/lib/format'
import { copy } from '@/lib/utils-dom'
import { cn } from '@/lib/utils'

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

// A rail section: its heading sits outside the card, 8px above it
function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function CopyLine({ url, big }: { url: string; big?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <code className={cn('truncate font-mono', big ? 'text-[15px] text-foreground' : 'text-[13px] text-muted-foreground')}>{url}</code>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy ${url}`}
        onClick={async () => ((await copy(url)) ? toast.success('Copied') : toast.error('The browser refused to copy'))}
      >
        <Copy />
      </Button>
    </div>
  )
}

// The name people type first (playpex.local), the addresses under it
function Addresses({ server }: { server: Overview['server'] }) {
  const host = server.discovery.mdns.state === 'advertising' ? server.discovery.mdns.host : null
  const named = host ? `http://${host}:${server.port}` : null
  return (
    <Section title="Addresses">
      <div className="space-y-4 rounded-xl bg-card p-5">
        {named && (
          <div className="space-y-1">
            <CopyLine url={named} big />
            <p className="text-xs text-muted-foreground">Type it on any phone, computer or TV on this network.</p>
          </div>
        )}
        <div className="space-y-1">
          {named && <p className="text-xs text-muted-foreground">Or by address</p>}
          {server.urls.map((url) => (
            <CopyLine key={url} url={url} big={!named} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">{server.lanSharing ? 'Shared on the LAN' : 'This machine only'}</Badge>
          <Discovery discovery={server.discovery} />
        </div>
        <p className="text-xs text-muted-foreground">
          {server.lanSharing && !named ? 'Give the server a name in Settings › Network, so nobody has to type an IP address. ' : ''}
          Version {server.version}, port {server.port}.
        </p>
      </div>
    </Section>
  )
}

function Meter({ label, value, fraction, low }: { label: string; value: string; fraction: number; low?: boolean }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('tabular-nums', low && 'text-destructive')}>{value}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-(--strip-track)">
        <div className={cn('h-full rounded-full', low ? 'bg-destructive' : 'bg-foreground/70')} style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} />
      </div>
    </div>
  )
}

function Disks({ disks }: { disks: Overview['disks'] }) {
  return (
    <Section title="Disk space">
      <div className="space-y-4 rounded-xl bg-card p-5">
        {disks.map((d) => {
          const used = d.total && d.free !== null ? (d.total - d.free) / d.total : 0
          const low = d.free !== null && d.free < 5 * 1024 ** 3
          return (
            <div key={d.id} title={d.path} className="space-y-1">
              <Meter label={DISK_LABELS[d.id] ?? d.id} value={`${bytes(d.free)} free of ${bytes(d.total)}`} fraction={used} low={low} />
              <p className="truncate font-mono text-xs text-muted-foreground/80">{d.path}</p>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function Machine({ data }: { data: Overview }) {
  const { process: p, system: s } = data
  const memUsed = s.totalMemBytes - s.freeMemBytes
  return (
    <Section title="Machine" action={<span className="truncate text-xs text-muted-foreground">{s.hostname}, {s.platform} {s.arch}</span>}>
      <div className="space-y-4 rounded-xl bg-card p-5 text-sm">
        <Meter label="Server CPU" value={`${p.cpuPercent.toFixed(1)}%`} fraction={p.cpuPercent / s.cpus / 100} />
        <Meter label="Memory" value={`${bytes(memUsed)} of ${bytes(s.totalMemBytes)}`} fraction={memUsed / s.totalMemBytes} />
        <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">The server uses</dt>
          <dd className="text-right tabular-nums">{bytes(p.rssBytes)}</dd>
          <dt className="text-muted-foreground">Load, 1 / 5 / 15 min</dt>
          <dd className="text-right tabular-nums">{s.loadAverage.map((l) => l.toFixed(2)).join('  ')}</dd>
          <dt className="text-muted-foreground">Runs on</dt>
          <dd className="text-right">
            {s.cpus} CPUs, Node {p.node}
            {p.electron ? `, Electron ${p.electron}` : ''}
          </dd>
        </dl>
      </div>
    </Section>
  )
}

function Services({ data }: { data: Overview }) {
  const ff = data.ffmpeg
  return (
    <Section title="Providers" action={<span className="text-xs text-muted-foreground">since the server started</span>}>
      <div className="rounded-xl bg-card px-5 pt-2 pb-3">
        <Table>
          <TableHeader>
            <TableRow className="border-0 hover:bg-transparent">
              <TableHead className="pl-0 font-normal text-muted-foreground">Name</TableHead>
              <TableHead className="font-normal text-muted-foreground">Last answer</TableHead>
              <TableHead className="hidden pr-0 font-normal text-muted-foreground sm:table-cell">Last failure</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="hover:bg-transparent">
              <TableCell className="pl-0">
                <span className="flex items-center gap-2">
                  <Dot state={ff.available ? 'ok' : 'bad'} />
                  ffmpeg
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground">{ff.available ? `${ff.version}, ${ff.source}` : 'not found'}</TableCell>
              <TableCell className="hidden pr-0 text-muted-foreground sm:table-cell">{ff.available ? '—' : 'Dolby / DTS sound plays silent'}</TableCell>
            </TableRow>
            {data.providers.map((p) => (
              <TableRow key={p.id} className="hover:bg-transparent">
                <TableCell className="pl-0">
                  <span className="flex items-center gap-2">
                    <Dot state={p.ok === null ? 'idle' : p.ok ? 'ok' : 'bad'} />
                    {p.name}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{p.ok === null ? 'not asked yet' : ago(p.lastSuccess)}</TableCell>
                <TableCell className="hidden pr-0 text-muted-foreground sm:table-cell">
                  {p.lastFailure ? `${ago(p.lastFailure)}: ${p.lastError}` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  )
}

type Problem = { text: ReactNode; fix?: { to: string; label: string } }

// "Is everything fine?": what needs the admin, first (docs/dashboard-plan.md §7)
function useProblems(data: Overview): Problem[] {
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
  return problems
}

function Problems({ problems }: { problems: Problem[] }) {
  if (!problems.length) return null
  return (
    <ul className="divide-y overflow-hidden rounded-xl bg-card">
      {problems.map((p, i) => (
        <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
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

// The live numbers: one strip split by rules, label over value, the window in words under it
function Live({ data, playing }: { data: Overview; playing: number }) {
  const cells: { label: string; value: ReactNode; note: string; to?: string }[] = [
    {
      label: 'Downloading',
      value: (
        <>
          <ArrowDown className="size-4 text-down" /> {speed(data.network.downloadSpeed)}
        </>
      ),
      note: `${bytes(data.network.downloaded)} since the server started`,
    },
    {
      label: 'Uploading',
      value: (
        <>
          <ArrowUp className="size-4 text-up" /> {speed(data.network.uploadSpeed)}
        </>
      ),
      note: `${bytes(data.network.uploaded)}, ${data.network.peers} ${data.network.peers === 1 ? 'peer' : 'peers'}`,
    },
    { label: 'Downloads running', value: data.downloads.active, note: `${data.downloads.queued} waiting their turn`, to: '/downloads' },
    { label: 'Playing', value: playing, note: playing === 1 ? 'one device watching' : `${playing} devices watching`, to: '/activity' },
  ]
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-xl bg-card xl:grid-cols-4">
      {cells.map((c, i) => {
        const body = (
          <>
            <div className="text-sm text-muted-foreground">{c.label}</div>
            <div className="mt-1 flex items-center gap-1.5 text-2xl tabular-nums">{c.value}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{c.note}</div>
          </>
        )
        const edge = cn('min-w-0 px-5 py-4', i % 2 === 1 && 'border-l', i >= 2 && 'border-t xl:border-t-0', i === 2 && 'xl:border-l')
        return c.to ? (
          <Link key={c.label} to={c.to} className={cn(edge, 'transition-colors hover:bg-accent')}>
            {body}
          </Link>
        ) : (
          <div key={c.label} className={edge}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

type Session = NonNullable<ReturnType<typeof useSessions>['data']>[number]

function useSessions() {
  return useQuery({ queryKey: ['sessions'], queryFn: () => unwrap(api.GET('/sessions')), refetchInterval: 5000 })
}

// What plays, on which device, how far: the screen's main block
function PlayingNow({ playing }: { playing: Session[] }) {
  return (
    <Section title="Playing now" action={<Link to="/activity" className="text-sm text-muted-foreground hover:text-foreground">Activity</Link>}>
      <div className="rounded-xl bg-card">
        {playing.length === 0 ? (
          <div className="px-5 py-8">
            <p className="text-sm">Nothing plays right now.</p>
            <p className="mt-1 text-sm text-muted-foreground">When a TV or this dashboard plays something, it shows here with how far it got.</p>
          </div>
        ) : (
          <ul className="divide-y">
            {playing.slice(0, 5).map((s) => {
              const p = s.playback
              const title = p?.title || s.file?.split('/').pop() || s.torrentName || 'Something'
              const at = p?.durationS ? Math.min(1, (p.positionS ?? 0) / p.durationS) : null
              return (
                <li key={s.id} className="space-y-2 px-5 py-4">
                  <div className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate font-medium" title={title}>
                      {title}
                    </span>
                    <span className="shrink-0 text-sm text-muted-foreground">{s.deviceName ?? s.deviceId}</span>
                  </div>
                  {at !== null && (
                    <div className="flex items-center gap-3">
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-(--strip-track)">
                        <span className="block h-full rounded-full bg-gold" style={{ width: `${at * 100}%` }} />
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {clock(p?.positionS)} of {clock(p?.durationS)}
                      </span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {playing.length > 5 && (
          <Link to="/activity" className="block border-t px-5 py-3 text-sm text-muted-foreground hover:text-foreground">
            {playing.length - 5} more on Activity
          </Link>
        )}
      </div>
    </Section>
  )
}

export function OverviewPage() {
  const overview = useOverview()
  const host = useHost()
  const sessions = useSessions()
  if (overview.isPending) return <Loading rows={4} />
  if (overview.error) return <QueryError error={overview.error} />
  return <OverviewBody data={overview.data} host={host.data} sessions={sessions.data ?? []} />
}

function OverviewBody({ data, host, sessions }: { data: Overview; host: ReturnType<typeof useHost>['data']; sessions: Session[] }) {
  const problems = useProblems(data)
  const playing = sessions.filter((s) => s.streaming || (s.playback && !s.playback.paused))
  const state = problems.length
    ? `${problems.length} ${problems.length === 1 ? 'thing needs' : 'things need'} you`
    : 'Everything is running'
  return (
    <>
      <PageHeader title="Overview" description={`${state}. ${data.server.name}, up ${duration(data.server.uptimeS)}.`} />
      <UpdateNotice host={host} streams={data.activity.sessions} />
      {data.sources.notice && <SourcesNotice />}
      <Problems problems={problems} />
      {/* the main column answers "what is it doing?"; the rail holds what the server is */}
      <div className="grid items-start gap-x-4 gap-y-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-8">
          <Live data={data} playing={playing.length} />
          <PlayingNow playing={playing} />
          <Services data={data} />
        </div>
        <div className="min-w-0 space-y-8">
          <Addresses server={data.server} />
          <Disks disks={data.disks} />
          <Machine data={data} />
        </div>
      </div>
    </>
  )
}
