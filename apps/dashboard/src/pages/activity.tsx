import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Gamepad2, Pause, Play, Radio, RotateCcw, RotateCw, Square, Users } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, Mono, PageHeader, QueryError } from '@/components/common'
import { SwarmStrip, toneOf } from '@/components/swarm-strip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, errorMessage, unwrap, type Session } from '@/lib/api'
import { useDownloads } from '@/lib/downloads'
import { ago, bytes, clock, speed } from '@/lib/format'

const METHOD: Record<string, string> = {
  direct: 'Direct play',
  'audio-transcode': 'Sound converted',
  'hls-transcode': 'Converted for a browser',
  hls: 'A plugin’s stream',
  live: 'Live',
}

// A torrent's pieces and the range this player reads, in gold (the Pieces tab's)
function SessionSwarm({ session }: { session: Session }) {
  const downloads = useDownloads()
  const d = downloads.data?.find((x) => x.infoHash === session.infoHash)
  const pieces = useQuery({
    queryKey: ['download-pieces', session.infoHash],
    queryFn: () => unwrap(api.GET('/downloads/{infoHash}/pieces', { params: { path: { infoHash: session.infoHash! } } })),
    enabled: !!session.infoHash,
    refetchInterval: 3000,
  })
  if (!d) return null
  const count = pieces.data?.count ?? 0
  const marks = count
    ? (pieces.data?.reads ?? [])
        .filter((r) => !session.file || r.path === session.file)
        .map((r) => ({ from: r.position / count, to: (Math.min(r.ahead, count - 1) + 1) / count }))
    : []
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>The torrent{marks.length ? ', and where this player reads' : ''}</span>
        <span className="tabular-nums">{d.progress === null ? '' : `${Math.floor(d.progress * 100)} %`}</span>
      </div>
      <SwarmStrip map={d.pieceMap} progress={d.progress} tone={toneOf(d)} marks={marks} className="h-2" />
    </div>
  )
}

function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => unwrap(api.GET('/sessions')),
    refetchInterval: 2000,
  })
}

function useTorrents() {
  return useQuery({
    queryKey: ['torrents'],
    queryFn: () => unwrap(api.GET('/torrents')),
    refetchInterval: 5000,
  })
}

function fileName(path: string | null) {
  return path ? path.split(/[\\/]/).pop() ?? path : null
}

type Command = { action: 'pause' | 'resume' | 'toggle' | 'seek' | 'seekBy' | 'stop'; positionS?: number; deltaS?: number }

// Why a session's player can't take commands now, or null
function commandBlock(session: Session) {
  if (!session.control?.online) return 'Device offline'
  if (!session.control.playback) return 'This device’s player doesn’t take commands'
  return null
}

// A control that says why it is off (a disabled button gets no pointer events: the tooltip sits on a wrapper)
function Blocked({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

function SessionCard({ session }: { session: Session }) {
  const client = useQueryClient()
  const blocked = commandBlock(session)
  const command = useMutation({
    mutationFn: (body: Command) =>
      unwrap(api.POST('/sessions/{id}/commands', { params: { path: { id: session.id } }, body })),
    // the player reports at once (a keepalive): the card shows it on the next fetch
    onSuccess: () => client.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (err) => toast.error(errorMessage(err)),
  })
  const stop = useMutation({
    mutationFn: () => unwrap(api.DELETE('/sessions/{id}', { params: { path: { id: session.id } } })),
    onSuccess: () => {
      toast.success('Session stopped')
      client.invalidateQueries({ queryKey: ['sessions'] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
  const p = session.playback
  const t = session.torrent
  const title = p?.title || fileName(session.file) || session.torrentName || session.infoHash || session.ref || "Unknown"
  const position = p?.durationS ? ((p.positionS ?? 0) / p.durationS) * 100 : null
  const downloaded = t?.length ? Math.min(100, (t.downloaded / t.length) * 100) : null
  const remote = !!(session.control?.online && (session.control.keyboard || session.control.pointer))
  const off = !!blocked || command.isPending
  const seekTo = (e: MouseEvent<HTMLDivElement>) => {
    if (off || !p?.durationS) return
    const box = e.currentTarget.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width))
    command.mutate({ action: 'seek', positionS: Math.round(f * p.durationS) })
  }
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="truncate text-base" title={title}>
            {title}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{session.deviceName ?? session.deviceId}</span>
            <span>·</span>
            <span>{session.address}</span>
            {session.client && (
              <>
                <span>·</span>
                <span>{session.client}</span>
              </>
            )}
          </div>
        </div>
        <Confirm
          title="Stop this session?"
          description="The player on the device is asked to stop; if it doesn't within 5 s, its stream is cut and the device's hold on the torrent is released."
          action="Stop"
          onConfirm={() => stop.mutate()}
          trigger={
            <Button variant="outline" size="sm" disabled={stop.isPending}>
              <Square /> Stop
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {session.streaming ? (
            <Badge>
              <Radio /> Streaming
            </Badge>
          ) : (
            <Badge variant="secondary">Idle</Badge>
          )}
          {p && (
            <Badge variant="outline">
              {p.paused ? <Pause /> : <Play />} {p.paused ? 'Paused' : 'Playing'}
            </Badge>
          )}
          {session.method && <Badge variant="outline">{METHOD[session.method] ?? session.method}</Badge>}
          {session.paired ? <Badge variant="outline">Paired</Badge> : <Badge variant="outline">Local</Badge>}
        </div>
        {position !== null && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Position</span>
              <span className="tabular-nums">
                {clock(p?.positionS)} / {clock(p?.durationS)}
              </span>
            </div>
            {/* a click on the line seeks there (a tall hit area around the thin bar) */}
            <div
              className={off ? 'py-1.5' : 'cursor-pointer py-1.5'}
              title={blocked ?? 'Click to go there'}
              onClick={seekTo}
            >
              <Progress value={position} />
            </div>
          </div>
        )}
        {p && (
          <div className="flex flex-wrap items-center gap-2">
            <Blocked reason={blocked}>
              <Button variant="outline" size="icon" aria-label="Back 10 seconds" disabled={off} onClick={() => command.mutate({ action: 'seekBy', deltaS: -10 })}>
                <RotateCcw />
              </Button>
            </Blocked>
            <Blocked reason={blocked}>
              <Button
                variant="outline"
                disabled={off}
                onClick={() => command.mutate({ action: p.paused ? 'resume' : 'pause' })}
              >
                {p.paused ? <Play /> : <Pause />} {p.paused ? 'Resume' : 'Pause'}
              </Button>
            </Blocked>
            <Blocked reason={blocked}>
              <Button variant="outline" size="icon" aria-label="Forward 10 seconds" disabled={off} onClick={() => command.mutate({ action: 'seekBy', deltaS: 10 })}>
                <RotateCw />
              </Button>
            </Blocked>
            {remote && (
              <Button asChild variant="ghost" className="ml-auto">
                <Link to={`/remote/${encodeURIComponent(session.deviceId)}`}>
                  <Gamepad2 /> Remote control
                </Link>
              </Button>
            )}
          </div>
        )}
        {!p && remote && (
          <Button asChild variant="ghost" size="sm">
            <Link to={`/remote/${encodeURIComponent(session.deviceId)}`}>
              <Gamepad2 /> Remote control
            </Link>
          </Button>
        )}
        {session.infoHash && <SessionSwarm session={session} />}
        {t && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums sm:grid-cols-4">
            <span className="flex items-center gap-1 text-muted-foreground">
              <Users className="size-3" /> {t.peers} peers
            </span>
            <span className="flex items-center gap-1 text-muted-foreground">
              <ArrowDown className="size-3 text-down" /> {speed(t.downloadSpeed)}
            </span>
            <span className="flex items-center gap-1 text-muted-foreground">
              <ArrowUp className="size-3 text-up" /> {speed(t.uploadSpeed)}
            </span>
            <span className="text-muted-foreground">
              {bytes(t.downloaded)}
              {downloaded !== null ? ` · ${downloaded.toFixed(0)} %` : ''}
            </span>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Started {ago(session.since)} · last activity {ago(session.lastActivity)}
        </p>
      </CardContent>
    </Card>
  )
}

export function ActivityPage() {
  const sessions = useSessions()
  const torrents = useTorrents()
  if (sessions.isPending) return <Loading />
  if (sessions.error) return <QueryError error={sessions.error} />
  const held = new Set(sessions.data.map((s) => s.infoHash))
  const orphans = (torrents.data ?? []).filter((t) => !held.has(t.infoHash))
  return (
    <>
      <PageHeader title="Activity" description="What every device is playing right now." />
      {sessions.data.length === 0 ? (
        <Empty icon={<Radio />} title="Nothing is playing">
          When a device plays something, from the library or a torrent, it shows here with how far it got.
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {sessions.data.map((s) => (
            <SessionCard key={s.id} session={s} />
          ))}
        </div>
      )}
      {orphans.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Torrents without a session</CardTitle>
            <p className="text-sm text-muted-foreground">
              No device holds them any more: they stop after the 30 s grace period.
            </p>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orphans.map((t) => (
                  <TableRow key={t.infoHash}>
                    <TableCell className="max-w-0 w-full">
                      <Mono>{t.name ?? t.infoHash}</Mono>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{bytes(t.length)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  )
}
