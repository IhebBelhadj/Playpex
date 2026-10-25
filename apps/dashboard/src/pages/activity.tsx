import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Pause, Play, Radio, Square, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Confirm, Empty, Loading, Mono, PageHeader, QueryError } from '@/components/common'
import { SwarmStrip, toneOf } from '@/components/swarm-strip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
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

function SessionCard({ session }: { session: Session }) {
  const client = useQueryClient()
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
          description="Its stream is closed and the device's hold on the torrent is released. The player on the device stops."
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
            <Progress value={position} />
          </div>
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
          Sessions appear here when a client starts a torrent.
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
