import { Link2, Pause, Play, RotateCw, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { Confirm, Empty } from '@/components/common'
import { Button } from '@/components/ui/button'
import { useDirectActions, type DirectDownload } from '@/lib/direct'
import { bytes, speed } from '@/lib/format'
import { usePlayer } from '@/lib/player'
import { cn } from '@/lib/utils'

// Downloads › Direct downloads (?filter=direct): files fetched over HTTP, not
// torrents (docs/search-plan.md decision C). Each: its name and where it comes
// from, its state, a bar (amber while it downloads, teal once done), sizes and
// speed; Pause / Start, Play once done (when the library has scanned it),
// Remove (its file too, or only the entry).

const STATE: Record<DirectDownload['state'], string> = {
  queued: 'Waiting',
  downloading: 'Downloading',
  paused: 'Paused',
  completed: 'Done',
  error: 'Failed',
}

export function DirectList({ downloads, q }: { downloads: DirectDownload[]; q: string }) {
  const shown = downloads.filter((d) => !q || d.name.toLowerCase().includes(q.toLowerCase()))
  if (!shown.length) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty icon={<Link2 />} title={downloads.length ? 'Nothing matches' : 'No direct downloads'}>
          Videos and streams found by Search or in a pasted link download here, over HTTP.{' '}
          <Link to="/search" className="font-medium text-foreground underline underline-offset-2">
            Search
          </Link>
        </Empty>
      </div>
    )
  }
  return (
    <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
      {shown.map((d) => (
        <DirectRow key={d.id} d={d} />
      ))}
    </ul>
  )
}

function DirectRow({ d }: { d: DirectDownload }) {
  const act = useDirectActions()
  const player = usePlayer()
  const done = d.state === 'completed'
  const share = d.size ? Math.min(1, d.received / d.size) : null
  const running = d.state === 'downloading' || d.state === 'queued'
  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium" title={d.path ?? d.name}>
            {d.name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{d.kind === 'hls' ? 'stream, saved with ffmpeg' : 'file'}</span>
        </div>
        {/* the bar: an unknown size (a stream) shows the bytes alone */}
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-[width]', done ? 'bg-up' : d.state === 'error' ? 'bg-destructive' : 'bg-down', share === null && running && 'w-1/3 animate-pulse')}
            style={share !== null ? { width: `${(done ? 1 : share) * 100}%` } : undefined}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground tabular-nums">
          <span className={cn(d.state === 'error' && 'text-destructive', done && 'text-up')}>{STATE[d.state]}</span>
          <span>
            {bytes(d.received)}
            {d.size && !done ? ` of ${bytes(d.size)}` : ''}
          </span>
          {d.state === 'downloading' && <span className="text-down">{speed(d.speed)}</span>}
          <span>from {d.source.by === 'links' ? d.source.host : `${d.source.host} (${d.source.by})`}</span>
          {d.error && <span className="text-destructive">{d.error}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {done && d.ref && (
          <Button variant="ghost" size="xs" onClick={() => player.play({ ref: d.ref!, title: d.name })}>
            <Play /> Play
          </Button>
        )}
        {running && (
          <Button variant="ghost" size="xs" onClick={() => act.pause.mutate(d.id)}>
            <Pause /> Pause
          </Button>
        )}
        {(d.state === 'paused' || d.state === 'error') && (
          <Button variant="ghost" size="xs" onClick={() => act.start.mutate(d.id)}>
            {d.state === 'error' ? <RotateCw /> : <Play />} {d.state === 'error' ? 'Try again' : 'Start'}
          </Button>
        )}
        <Confirm
          trigger={
            <Button variant="ghost" size="icon-xs" aria-label="Remove" title="Remove" className="hover:text-destructive">
              <Trash2 />
            </Button>
          }
          title={`Remove ${d.name}?`}
          description={done ? 'Its file is deleted from the download folder.' : 'It stops, and what it downloaded so far is deleted.'}
          action="Remove"
          onConfirm={() => act.remove.mutate({ id: d.id, files: true })}
        />
      </div>
    </li>
  )
}

